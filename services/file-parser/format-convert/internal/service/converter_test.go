package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLibreOfficeConverterProducesPDF(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	workDir := t.TempDir()
	inputPath := filepath.Join(workDir, "input.docx")
	if err := os.WriteFile(inputPath, []byte{'P', 'K', 3, 4}, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := writeSofficeFixture(t, `
outdir=""
input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then
    shift
    outdir="$1"
  fi
  input="$1"
  shift
done
printf '%%PDF-1.7\n%%%%EOF\n' > "$outdir/$(basename "${input%.*}").pdf"
`)
	converter := LibreOfficeConverter{Binary: fixture}

	outputPath, err := converter.Convert(context.Background(), inputPath, workDir)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content[:5]) != "%PDF-" {
		t.Fatal("expected PDF output")
	}
}

func TestLibreOfficeConverterHonorsCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	workDir := t.TempDir()
	inputPath := filepath.Join(workDir, "input.docx")
	if err := os.WriteFile(inputPath, []byte{'P', 'K', 3, 4}, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := writeSofficeFixture(t, "sleep 10")
	converter := LibreOfficeConverter{Binary: fixture}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	_, err := converter.Convert(ctx, inputPath, workDir)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline error, got %v", err)
	}
}

func writeSofficeFixture(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "soffice-fixture")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
