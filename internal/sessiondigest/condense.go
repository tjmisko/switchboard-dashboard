package sessiondigest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Summary is the LLM-generated session identity — the analog of the authored
// name/description a subagent gets from its parent at spawn time, which
// interactive sessions otherwise lack — plus the discrete work items and a
// short narrative.
type Summary struct {
	Name        string   `json:"name"`            // kebab-case slug for the work
	Description string   `json:"description"`     // one sentence, hover-modal sized
	Summary     string   `json:"summary"`         // framing prose: 1-2 sentences with tasks, 3-6 without
	Tasks       []string `json:"tasks,omitempty"` // distinct tasks, chronological, at most maxSummaryTasks
}

// Record is the persisted per-session artifact: the deterministic digest plus
// the generated summary, the output-schema version that generated it, and its
// provenance.
type Record struct {
	Digest         Digest   `json:"digest"`
	Summary        *Summary `json:"summary,omitempty"`
	SummaryVersion int      `json:"summaryVersion,omitempty"`
	Model          string   `json:"model,omitempty"`
	GeneratedAt    string   `json:"generatedAt,omitempty"`
	// DigestHash fingerprints the digest the summary was written from, so a
	// session that ends, is resumed, and ends again — rebuilding its digest
	// under an unchanged summary — is caught by NeedsCondense. Empty means
	// "unknown", never "stale"; see NeedsCondense.
	DigestHash string `json:"digestHash,omitempty"`
	// SummaryRejectedReason and SummaryRejectedAt hold why the last condense
	// attempt produced no summary. They are provenance, not lifecycle: neither
	// is read by NeedsCondense, so a rejected record stays queued and is retried
	// on the next run exactly as an unattempted one is. Without them a refusal
	// reached only the log, and a session that never acquires a summary looked
	// the same as one that was never attempted.
	SummaryRejectedReason string `json:"summaryRejectedReason,omitempty"`
	SummaryRejectedAt     string `json:"summaryRejectedAt,omitempty"`
}

// CurrentSummaryVersion is the condenser's output-schema version. v2 added
// Summary.Tasks; records still at an older version are re-condensed by a plain
// `-condense` run (see NeedsCondense) so the archive converges on the current
// shape without -force, which would needlessly rebuild every digest too.
const CurrentSummaryVersion = 2

// maxSummaryTasks caps the task list. The prompt already asks for the six most
// substantial tasks when a session had more, so truncating here is only a
// backstop against a model that ignores the cap.
const maxSummaryTasks = 6

// Runner produces the model's raw response for a prompt. The default is
// ClaudeRunner; tests substitute a fake.
type Runner func(prompt string) (string, error)

// Caps on how much of each digest list the condenser prompt includes; the
// overflow is noted so the model knows the list was truncated.
const (
	maxPromptLinesInPrompt = 30
	maxListLinesInPrompt   = 40
)

// BuildPrompt renders a digest into the condenser prompt. The model sees only
// this digest — never the raw transcript — which keeps the call cheap and the
// output grounded in extracted facts.
func BuildPrompt(d Digest) string {
	var sb strings.Builder
	sb.WriteString(`Write an archival index card for a finished Claude Code session, from its digest below.
Return ONLY a JSON object, no prose and no code fences:
{"name": "...", "description": "...", "tasks": ["...", "..."], "summary": "..."}
- "name": kebab-case slug naming the work, at most six words
- "description": one sentence, under 120 characters, saying what the session did
- "tasks": one entry per DISTINCT task the session completed, in chronological order.
  Return [] when the session was a single continuous task — never a one-entry list.
  At most 6 entries. If the session had more distinct tasks than that, keep the SIX
  MOST SUBSTANTIAL ones, not the first six.
  Each entry is a short past-tense clause under 120 characters, not a sentence:
  "Fixed the merged-view session-id lookup". No leading bullet or number.
- "summary": when "tasks" is non-empty, 1-2 plain sentences of framing only — what the
  session was about and where it landed — since the tasks already list the work.
  When "tasks" is empty, 3-6 plain sentences on what happened and where it landed.

Session digest:
`)
	field := func(key, value string) {
		if value != "" {
			fmt.Fprintf(&sb, "%s: %s\n", key, value)
		}
	}
	field("title", d.Title)
	field("agent-name", d.AgentName)
	field("project", d.ProjectDir)
	field("branch", d.GitBranch)
	field("started", d.StartedAt)
	field("ended", d.EndedAt)

	list := func(key string, values []string, limit int) {
		if len(values) == 0 {
			return
		}
		fmt.Fprintf(&sb, "%s:\n", key)
		shown := len(values)
		if shown > limit {
			shown = limit
		}
		for _, v := range values[:shown] {
			fmt.Fprintf(&sb, "  - %s\n", strings.ReplaceAll(v, "\n", " "))
		}
		if len(values) > shown {
			fmt.Fprintf(&sb, "  … and %d more\n", len(values)-shown)
		}
	}
	list("user prompts (in order)", d.UserPrompts, maxPromptLinesInPrompt)
	list("commits", d.CommitSubjects, maxListLinesInPrompt)
	list("files edited", d.FilesEdited, maxListLinesInPrompt)
	list("bash steps", d.BashDescriptions, maxListLinesInPrompt)

	if len(d.Subagents) > 0 {
		sb.WriteString("subagents delegated (descriptions authored at spawn):\n")
		for _, sa := range d.Subagents {
			label := sa.Name
			if label == "" {
				label = sa.AgentType
			}
			if label == "" {
				label = "agent"
			}
			fmt.Fprintf(&sb, "  - %s: %s\n", label, sa.Description)
		}
	}
	if d.FinalAssistantText != "" {
		sb.WriteString("final assistant message:\n")
		for _, line := range strings.Split(strings.TrimSpace(d.FinalAssistantText), "\n") {
			sb.WriteString("  " + line + "\n")
		}
	}
	return sb.String()
}

// promptFields mirrors the digest fields BuildPrompt renders, and only those.
// A digest carries more than the prompt shows — session and project ids, tool
// counts, a subagent's model — and a change confined to those is a change the
// summary could not possibly have reflected, so it must not buy a re-condense.
// JSON gives the hash its canonical form for free: encoding/json writes struct
// fields in declaration order and sorts map keys, so equal inputs always
// encode to identical bytes no matter how the digest was built. (Nothing here
// is a map today — ToolCounts, the only one on Digest, is not in the prompt —
// but a field added later inherits that guarantee.)
type promptFields struct {
	Title              string           `json:"title,omitempty"`
	AgentName          string           `json:"agentName,omitempty"`
	ProjectDir         string           `json:"projectDir,omitempty"`
	GitBranch          string           `json:"gitBranch,omitempty"`
	StartedAt          string           `json:"startedAt,omitempty"`
	EndedAt            string           `json:"endedAt,omitempty"`
	UserPrompts        []string         `json:"userPrompts,omitempty"`
	CommitSubjects     []string         `json:"commitSubjects,omitempty"`
	FilesEdited        []string         `json:"filesEdited,omitempty"`
	BashDescriptions   []string         `json:"bashDescriptions,omitempty"`
	Subagents          []promptSubagent `json:"subagents,omitempty"`
	FinalAssistantText string           `json:"finalAssistantText,omitempty"`
}

// promptSubagent is the part of a Subagent the prompt shows: its label — Name,
// or AgentType when the name is blank — and the authored description.
type promptSubagent struct {
	Name        string `json:"name,omitempty"`
	AgentType   string `json:"agentType,omitempty"`
	Description string `json:"description,omitempty"`
}

// HashDigest fingerprints the prompt-visible half of a digest. Two digests
// that would render the same prompt hash the same, which is what lets
// NeedsCondense tell a rebuilt-and-changed digest from a rebuilt-and-identical
// one without keeping the old digest around.
func HashDigest(d Digest) string {
	fields := promptFields{
		Title:              d.Title,
		AgentName:          d.AgentName,
		ProjectDir:         d.ProjectDir,
		GitBranch:          d.GitBranch,
		StartedAt:          d.StartedAt,
		EndedAt:            d.EndedAt,
		UserPrompts:        d.UserPrompts,
		CommitSubjects:     d.CommitSubjects,
		FilesEdited:        d.FilesEdited,
		BashDescriptions:   d.BashDescriptions,
		FinalAssistantText: d.FinalAssistantText,
	}
	for _, sa := range d.Subagents {
		fields.Subagents = append(fields.Subagents, promptSubagent{
			Name:        sa.Name,
			AgentType:   sa.AgentType,
			Description: sa.Description,
		})
	}
	// promptFields is strings and slices of them, so a failure here is a bug;
	// hashing the empty encoding instead would silently freeze every record's
	// hash and quietly disable the staleness check.
	raw, err := json.Marshal(fields)
	if err != nil {
		panic("sessiondigest: hash prompt fields: " + err.Error())
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// ParseSummary extracts the condenser's JSON object from a model response,
// tolerating code fences and surrounding prose. Only description is required:
// a schema-confused reply that drops or mangles tasks still yields a usable
// card rather than an error.
func ParseSummary(out string) (Summary, error) {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start < 0 || end <= start {
		return Summary{}, errors.New("no JSON object in model output")
	}
	// tasks is decoded raw because models return it as an array, as one
	// newline-delimited string, or as null — see parseTasks.
	var wire struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Summary     string          `json:"summary"`
		Tasks       json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &wire); err != nil {
		return Summary{}, fmt.Errorf("parse summary JSON: %w", err)
	}
	if wire.Description == "" {
		return Summary{}, errors.New("summary JSON missing description")
	}
	return Summary{
		Name:        wire.Name,
		Description: wire.Description,
		Summary:     wire.Summary,
		Tasks:       parseTasks(wire.Tasks),
	}, nil
}

// The bounds BuildPrompt states to the model. They live here as constants so
// the prompt and the check that enforces it cannot drift apart silently.
const (
	maxSummaryNameWords  = 6
	maxSummaryFieldRunes = 120
)

// kebabCase matches the slug shape the prompt asks for: lowercase words joined
// by single hyphens, no leading, trailing or doubled separator.
var kebabCase = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// Validate reports why a summary cannot be trusted, or nil when it can.
//
// ParseSummary above is the extraction step: it recovers the object from
// whatever prose or fences the model wrapped it in, and normalizes the shapes
// models are known to return tasks in. This is the contract step, and it is
// deliberately separate — extraction asks "what did the model say", validation
// asks "is that what we asked for".
//
// Every rule here restates something BuildPrompt already told the model. A
// violation therefore means the reply did not follow the contract, and the
// reply is refused whole rather than repaired: these fields are persisted and
// rendered, so a half-understood one is worse than none. The caller leaves the
// record stale, which queues it for the next run — see CondenseRecord.
//
// Note what is NOT checked here, because the extraction layer has already made
// a reasoned choice about it: a tasks array holding one non-string among
// several strings costs that entry rather than the list, and more than
// maxSummaryTasks entries are truncated rather than refused. Both are cases
// where the invalid part is separable from the valid one — dropping it leaves
// exactly what the contract asked for. Nothing below is separable in that way.
func (s Summary) Validate() error {
	// Emptiness is checked after trimming throughout: ParseSummary's own
	// required-description check tests for "" exactly, so a reply of "   "
	// reaches here looking populated and rendering blank.
	if strings.TrimSpace(s.Name) == "" {
		return errors.New("summary name is empty")
	}
	if !kebabCase.MatchString(s.Name) {
		return fmt.Errorf("summary name %q is not kebab-case", s.Name)
	}
	if words := strings.Count(s.Name, "-") + 1; words > maxSummaryNameWords {
		return fmt.Errorf("summary name %q is %d words, at most %d allowed", s.Name, words, maxSummaryNameWords)
	}
	if strings.TrimSpace(s.Description) == "" {
		return errors.New("summary description is empty")
	}
	if n := utf8.RuneCountInString(s.Description); n >= maxSummaryFieldRunes {
		return fmt.Errorf("summary description is %d characters, under %d required", n, maxSummaryFieldRunes)
	}
	if strings.TrimSpace(s.Summary) == "" {
		return errors.New("summary prose is empty")
	}
	// These fields are persisted and rendered. escapeHTML on the way to the DOM
	// handles markup; it does nothing about a NUL, a stray control byte, or a
	// bidi override that reorders the visible text against its content. None of
	// them are sentence content, so their presence means the reply is not what
	// was asked for.
	for field, value := range map[string]string{
		"name":        s.Name,
		"description": s.Description,
		"prose":       s.Summary,
	} {
		// Prose is the one field the prompt allows several sentences in, so a
		// newline there is plausible formatting rather than a malformed reply.
		if err := checkTextBytes(field, value, field == "prose"); err != nil {
			return err
		}
	}
	if len(s.Tasks) > maxSummaryTasks {
		// Unreachable via ParseSummary, which caps first. Checked anyway: this
		// validates a Summary, not the path it happened to arrive by.
		return fmt.Errorf("summary carries %d tasks, at most %d allowed", len(s.Tasks), maxSummaryTasks)
	}
	for i, task := range s.Tasks {
		if strings.TrimSpace(task) == "" {
			return fmt.Errorf("summary task %d is empty", i)
		}
		if n := utf8.RuneCountInString(task); n >= maxSummaryFieldRunes {
			return fmt.Errorf("summary task %d is %d characters, under %d required", i, n, maxSummaryFieldRunes)
		}
		if err := checkTextBytes(fmt.Sprintf("task %d", i), task, false); err != nil {
			return err
		}
	}
	return nil
}

// checkTextBytes rejects text that is not well-formed prose: invalid UTF-8, a
// control character, or a bidirectional override. multiline allows \n and \t,
// which are formatting in a several-sentence field and noise in a one-line one.
func checkTextBytes(field, value string, multiline bool) error {
	if !utf8.ValidString(value) {
		return fmt.Errorf("summary %s is not valid UTF-8", field)
	}
	for _, r := range value {
		if multiline && (r == '\n' || r == '\t') {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("summary %s holds control character %U", field, r)
		}
		// LRE/RLE/PDF/LRO/RLO, the isolates, and the LRM/RLM marks. These
		// reorder rendered text against the string's actual content.
		if (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) || r == 0x200e || r == 0x200f {
			return fmt.Errorf("summary %s holds bidirectional override %U", field, r)
		}
	}
	return nil
}

// taskMarker matches a list marker the model sometimes leaves on an entry
// ("- ", "* ", "1. "). Every marker must be followed by whitespace: that is
// what keeps a task opening with a flag ("-force also rebuilds digests") or a
// decimal ("3.5x faster parse") from losing its leading characters.
var taskMarker = regexp.MustCompile(`^(?:[-*•]|\d+[.)])\s+`)

// parseTasks normalizes the model's tasks field: absent, null, a JSON array of
// strings, or a single string holding newline-delimited bullets. Entries are
// stripped of list markers, trimmed, dropped when empty, and capped at
// maxSummaryTasks. An unparseable field yields no tasks rather than an error —
// tasks are optional enrichment, never a reason to lose the whole summary.
func parseTasks(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var tasks []string
	for _, entry := range taskEntries(raw) {
		task := strings.TrimSpace(taskMarker.ReplaceAllString(strings.TrimSpace(entry), ""))
		if task == "" {
			continue
		}
		tasks = append(tasks, task)
		if len(tasks) == maxSummaryTasks {
			break
		}
	}
	return tasks
}

// taskEntries splits the raw tasks field into unnormalized entries. A JSON
// array keeps only the elements that are themselves strings, so the common
// "model emitted one object among six strings" reply costs that one bullet
// instead of the whole list; a lone string is split on newlines; anything else
// yields none.
func taskEntries(raw json.RawMessage) []string {
	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		var single string
		if json.Unmarshal(raw, &single) != nil {
			return nil
		}
		return strings.Split(single, "\n")
	}
	var entries []string
	for _, element := range elements {
		var entry string
		if json.Unmarshal(element, &entry) == nil {
			entries = append(entries, entry)
		}
	}
	return entries
}

// NeedsCondense reports whether a record's summary has to be generated: it is
// missing, it was written by an older output schema (so it lacks fields the
// current one carries, such as Tasks), the digest it describes has since been
// rebuilt with different content — a session that ended, was resumed, and
// ended again — or the caller passed -force.
func NeedsCondense(record Record, force bool) bool {
	if force {
		return true
	}
	if record.Summary == nil {
		return true
	}
	if record.SummaryVersion < CurrentSummaryVersion {
		return true
	}
	// An empty hash means "unknown", not "stale". Every record written before
	// this field existed has one, and treating those as stale would re-condense
	// the entire archive at one `claude -p` call apiece — the same bill -force
	// runs up, which is exactly what the hash is here to avoid. Those records
	// get stamped whenever something else re-condenses them, so the archive
	// converges slowly and costs nothing today.
	if record.DigestHash == "" {
		return false
	}
	return record.DigestHash != HashDigest(record.Digest)
}

// Condense generates a Summary for the digest via run, and refuses one that
// does not meet the contract BuildPrompt stated — see Summary.Validate. A
// refusal is an error like any other here, so the caller leaves the record
// stale and the next run tries again.
func Condense(d Digest, run Runner) (Summary, error) {
	out, err := run(BuildPrompt(d))
	if err != nil {
		return Summary{}, err
	}
	summary, err := ParseSummary(out)
	if err != nil {
		return Summary{}, err
	}
	if err := summary.Validate(); err != nil {
		return Summary{}, fmt.Errorf("model reply rejected: %w", err)
	}
	return summary, nil
}

// CondenseRecord condenses the record's digest in place and stamps the schema
// version and the digest hash that produced the summary, which is what makes
// the next run's NeedsCondense skip it — without the stamps every plain
// -condense run would re-summarize the whole archive. A failed run stamps none
// of them, so the retry happens next time rather than marking a missing summary
// current; it records why it failed instead.
//
// Reporting whether the record changed lets the caller write a refusal without
// having to know which fields carry one.
func CondenseRecord(record *Record, run Runner, model string, now time.Time) (changed bool, err error) {
	summary, err := Condense(record.Digest, run)
	if err != nil {
		reason := err.Error()
		// Rewriting an unchanged reason every run would churn the file for a
		// session that fails the same way each time.
		if record.SummaryRejectedReason == reason {
			return false, err
		}
		record.SummaryRejectedReason = reason
		record.SummaryRejectedAt = now.UTC().Format(time.RFC3339)
		return true, err
	}
	record.Summary = &summary
	record.SummaryVersion = CurrentSummaryVersion
	record.Model = model
	record.GeneratedAt = now.UTC().Format(time.RFC3339)
	record.DigestHash = HashDigest(record.Digest)
	// A success supersedes whatever the last attempt failed on; leaving the
	// reason behind would describe a record that now has a summary.
	record.SummaryRejectedReason = ""
	record.SummaryRejectedAt = ""
	return true, nil
}

// claudeArgv is the summarizer's command line, split out from ClaudeRunner so
// the constraint below is a pure value a test can assert on. The exec call
// itself stays untested; the argv is the part that matters.
//
// The summarizer reads a prompt on stdin and returns JSON. It needs no tools
// whatever, so it is given none — that is what --tools "" does. This is
// deliberately a property of the argv rather than of configuration: fencing an
// agent by allowlisting tools, or by trusting the ambient settings file to
// withhold them, is a configuration, and configurations are got wrong. An agent
// with no tools at all cannot damage anything whatever it concludes.
//
// --restricted also makes the child ignore user, project and local settings
// files, so the constraint does not depend on what ~/.claude/settings.json
// happens to grant today. --strict-mcp-config skips MCP servers, which the
// summarizer has no use for and which would otherwise be spawned on every
// SessionEnd.
func claudeArgv(model string) []string {
	return []string{
		"-p",
		"--model", model,
		"--tools", "",
		"--restricted",
		"--strict-mcp-config",
	}
}

// ClaudeRunner shells out to `claude -p` in headless mode with no tools; see
// claudeArgv for why. dir becomes the subprocess working directory so the
// summarizer's own transcripts land under dir's project slug — which callers
// skip via SlugFor — instead of polluting real projects.
func ClaudeRunner(model, dir string, timeout time.Duration) Runner {
	return func(prompt string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, "claude", claudeArgv(model)...)
		cmd.Dir = dir
		cmd.Stdin = strings.NewReader(prompt)
		out, err := cmd.Output()
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
				return "", fmt.Errorf("claude -p: %w: %s", err, exitErr.Stderr)
			}
			return "", fmt.Errorf("claude -p: %w", err)
		}
		return string(out), nil
	}
}
