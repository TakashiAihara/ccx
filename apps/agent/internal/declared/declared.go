// Package declared reads a session's declared-state files the way core
// (packages/core/src/session-state.ts readDeclared) reads them, so the agent and
// the CLI agree on every value (packages/core/testdata/text-cases.json, #191).
package declared

import (
	"os"
	"strings"
	"unicode"
	"unicode/utf8"
)

// JSSpace is what JavaScript's String.prototype.trim removes: Go's
// unicode.IsSpace also counts U+0085 and misses U+FEFF.
func JSSpace(r rune) bool { return r == '\uFEFF' || (r != '\u0085' && unicode.IsSpace(r)) }

// Text is a declared text file (label, task, role, heartbeat): a file that is
// missing, unreadable or not UTF-8 reads as "", the rest is trimmed as
// JavaScript trims.
func Text(path string) string {
	b, err := os.ReadFile(path)
	if err != nil || !utf8.Valid(b) {
		return ""
	}
	return strings.TrimFunc(string(b), JSSpace)
}
