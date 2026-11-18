package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

func TestLibreOfficeConverterRunsWithMinimalEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}
	const secretName = "FORMAT_CONVERT_TEST_SECRET"
	t.Setenv(secretName, "must-not-reach-converter")
	workDir := t.TempDir()
	inputPath := filepath.Join(workDir, "input.docx")
	if err := os.WriteFile(inputPath, []byte{'P', 'K', 3, 4}, 0o600); err != nil {
		t.Fatal(err)
	}
	envDump := filepath.Join(workDir, "env.txt")
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
env > "`+envDump+`"
printf '%%PDF-1.7\n%%%%EOF\n' > "$outdir/$(basename "${input%.*}").pdf"
`)
	converter := LibreOfficeConverter{Binary: fixture}

	if _, err := converter.Convert(context.Background(), inputPath, workDir); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(envDump)
	if err != nil {
		t.Fatal(err)
	}
	env := string(content)
	if strings.Contains(env, secretName) {
		t.Fatal("converter subprocess inherited the parent environment")
	}
	if !strings.Contains(env, "HOME="+workDir) || !strings.Contains(env, "TMPDIR="+workDir) {
		t.Fatalf("converter sandbox variables missing: %s", env)
	}
	if !strings.Contains(env, "PATH=/usr/bin:/bin") {
		t.Fatal("converter PATH must be fixed")
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
	if !fixtureFilesystemExecutable(filepath.Dir(path)) {
		t.Skip("shell fixture requires executable scratch; real Office and static sandbox probes cover noexec production runtime")
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConverterSandboxDeniesOtherWorkspacesAndNetwork(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("native sandbox adapter unavailable")
	}
	if _, err := os.Stat("/usr/bin/curl"); err != nil {
		t.Skip("sandbox network fixture requires curl")
	}
	protected := filepath.Join(t.TempDir(), "synthetic-private-document")
	if err := os.WriteFile(protected, []byte("synthetic fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	listener := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("synthetic")) }))
	defer listener.Close()
	fixture := writeSofficeFixture(t, `
if cat "`+protected+`" >/dev/null 2>&1; then exit 10; fi
if /usr/bin/curl --silent --max-time 1 "`+listener.URL+`" >/dev/null 2>&1; then exit 11; fi
outdir=""
input=""
while [ "$#" -gt 0 ]; do
 if [ "$1" = "--outdir" ]; then shift; outdir="$1"; fi
 input="$1"
 shift
done
printf '%%PDF-1.7\n%%%%EOF\n' > "$outdir/$(basename "${input%.*}").pdf"
`)
	work := t.TempDir()
	input := filepath.Join(work, "input.doc")
	os.WriteFile(input, []byte("synthetic"), 0600)
	if _, err := (LibreOfficeConverter{Binary: fixture}).Convert(context.Background(), input, work); err != nil {
		t.Fatal("sandbox denied legitimate output or failed to deny fixture access")
	}
}

func TestConverterRejectsOutputSymlink(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("sandbox adapter unavailable")
	}
	synthetic := filepath.Join(t.TempDir(), "synthetic.pdf")
	os.WriteFile(synthetic, []byte("%PDF-1.7\n"), 0600)
	fixture := writeSofficeFixture(t, `
outdir=""
input=""
while [ "$#" -gt 0 ]; do
 if [ "$1" = "--outdir" ]; then shift; outdir="$1"; fi
 input="$1"
 shift
done
ln -s "`+synthetic+`" "$outdir/$(basename "${input%.*}").pdf"
`)
	work := t.TempDir()
	input := filepath.Join(work, "input.doc")
	os.WriteFile(input, []byte("synthetic"), 0600)
	if _, err := (LibreOfficeConverter{Binary: fixture}).Convert(context.Background(), input, work); err == nil {
		t.Fatal("host followed converter output symlink")
	}
}

// Runs only the installed converter against generated synthetic text/documents.
// A discovered executable with unusable isolation is a failure, not a skip.
func TestInstalledLibreOfficeSandboxConvertsSyntheticDOCX(t *testing.T) {
	binary, err := exec.LookPath("soffice")
	if err != nil {
		t.Skip("installed LibreOffice unavailable")
	}
	if runtime.GOOS == "darwin" {
		resolved, resolveErr := filepath.EvalSymlinks(binary)
		if resolveErr != nil || !strings.Contains(resolved, ".app/Contents/MacOS/") {
			t.Skip("direct installed LibreOffice app executable unavailable; launch wrapper is not qualified")
		}
	}
	converter := LibreOfficeConverter{Binary: binary}
	if err := converter.Ready(); err != nil {
		t.Fatal("installed converter isolation readiness failed")
	}
	work := t.TempDir()
	text := filepath.Join(work, "synthetic.txt")
	if err := os.WriteFile(text, []byte("Synthetic document\n中文合成文档\n"), 0600); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(work, "synthetic.docx")
	if err := CreateDOCXFromText(text, input); err != nil {
		t.Fatal(err)
	}
	if _, code := validateArchiveStructure(input, 50<<20); code != "" {
		t.Fatal("generated legitimate document rejected")
	}
	output, err := converter.Convert(context.Background(), input, work)
	if err != nil {
		t.Fatal("installed converter could not convert synthetic DOCX")
	}
	data, err := os.ReadFile(output)
	if err != nil || !strings.HasPrefix(string(data), "%PDF-") {
		t.Fatal("installed converter output invalid")
	}
	// A legacy DOC fixture is generated from the same synthetic package inside
	// the actual sandbox, without reading or altering any existing user document.
	err = runOfficeSandbox(context.Background(), binary, work, []string{"--headless", "--nologo", "-env:UserInstallation=" + (&url.URL{Scheme: "file", Path: filepath.Join(work, "profile")}).String(), "--convert-to", "doc:MS Word 97", "--outdir", work, input})
	if err != nil {
		t.Fatal("could not create synthetic legacy DOC fixture")
	}

	legacyInput := filepath.Join(work, "synthetic.doc")
	if !hasWordSignature(legacyInput, ".doc") {
		t.Fatal("legacy fixture invalid")
	}
	if _, err := converter.Convert(context.Background(), legacyInput, work); err != nil {
		t.Fatal("legacy DOC conversion failed")
	}
	// Exercise normal HTTP contracts with actual Office, including Chinese text.
	docxBytes, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name    string
		content []byte
	}{
		{"synthetic.txt", []byte("Synthetic text\n中文合成文档\n")},
		{"synthetic.docx", docxBytes},
	} {
		response := httptest.NewRecorder()
		NewHTTPHandler(testConfig(t), converter, nil).ServeHTTP(response, multipartRequestWithTarget(t, scenario.name, scenario.content, "pdf"))
		if response.Code != http.StatusOK || !strings.HasPrefix(response.Body.String(), "%PDF-") {
			t.Fatal("normal HTTP Office conversion failed")
		}
	}
}
