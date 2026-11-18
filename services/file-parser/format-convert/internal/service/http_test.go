package service

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeConverter struct {
	readyErr error
}

var testAuthToken = fmt.Sprintf("format-convert-test-token-%032d", time.Now().UnixNano())

type blockingConverter struct {
	started   chan struct{}
	release   chan struct{}
	active    atomic.Int64
	maxActive atomic.Int64
}

func newBlockingConverter() *blockingConverter {
	return &blockingConverter{started: make(chan struct{}, 8), release: make(chan struct{})}
}

func (converter *blockingConverter) Ready() error { return nil }

func (converter *blockingConverter) Convert(ctx context.Context, _ string, workDir string) (string, error) {
	active := converter.active.Add(1)
	defer converter.active.Add(-1)
	for {
		maximum := converter.maxActive.Load()
		if active <= maximum || converter.maxActive.CompareAndSwap(maximum, active) {
			break
		}
	}
	converter.started <- struct{}{}
	select {
	case <-converter.release:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	output := filepath.Join(workDir, "fixture.pdf")
	return output, os.WriteFile(output, []byte("%PDF-1.7\n%%EOF\n"), 0o600)
}

func (converter fakeConverter) Ready() error {
	return converter.readyErr
}

func (converter fakeConverter) Convert(_ context.Context, _ string, workDir string) (string, error) {
	output := filepath.Join(workDir, "fixture.pdf")
	return output, os.WriteFile(output, []byte("%PDF-1.7\n%%EOF\n"), 0o600)
}

func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		Port:           8080,
		MaxUploadBytes: 1 << 20,
		MaxOutputBytes: 2 << 20,
		MaxConcurrency: 1,
		QueueCapacity:  0,
		QueueTimeout:   100 * time.Millisecond,
		TempRoot:       t.TempDir(),
		SofficeBinary:  "soffice",
		AuthToken:      testAuthToken,
	}
}

func multipartRequest(t *testing.T, name string, content []byte) *http.Request {
	return multipartRequestWithTarget(t, name, content, "")
}

func multipartRequestWithTarget(t *testing.T, name string, content []byte, target string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if target != "" {
		if err := writer.WriteField("targetFormat", target); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/convert", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+testAuthToken)
	return request
}

func TestConvertTXTToDOCX(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	request := multipartRequestWithTarget(t, "classic.txt", []byte("First paragraph wraps\nonto another line.\n\nSecond & final paragraph."), "docx")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != docxMediaType {
		t.Fatalf("unexpected content type: %s", response.Header().Get("Content-Type"))
	}
	if !strings.Contains(response.Header().Get("Content-Disposition"), "classic.docx") {
		t.Fatalf("unexpected disposition: %s", response.Header().Get("Content-Disposition"))
	}
	archive, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	document := readZipEntry(t, archive, "word/document.xml")
	if !strings.Contains(document, "First paragraph wraps onto another line.") {
		t.Fatalf("wrapped prose was not normalized: %s", document)
	}
	if !strings.Contains(document, "Second &amp; final paragraph.") {
		t.Fatalf("XML text was not escaped: %s", document)
	}
	if !strings.Contains(readZipEntry(t, archive, "word/styles.xml"), "Liberation Serif") {
		t.Fatal("expected deterministic document font")
	}
}

func TestConvertTXTToPDFByDefault(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	request := multipartRequest(t, "classic.txt", []byte("A public-domain paragraph."))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != pdfMediaType || !strings.HasPrefix(response.Body.String(), "%PDF-") {
		t.Fatal("expected PDF response")
	}
}

func TestRejectsInvalidUTF8Text(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	request := multipartRequestWithTarget(t, "classic.txt", []byte{0xff, 0xfe, 0xfd}, "docx")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "text_encoding_invalid") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func testDocxArchive(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	contentTypes, err := archive.Create("[Content_Types].xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := contentTypes.Write([]byte(`<?xml version="1.0"?><Types></Types>`)); err != nil {
		t.Fatal(err)
	}
	for name, content := range entries {
		member, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := member.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

type countingConverter struct {
	calls atomic.Int64
}

func (converter *countingConverter) Ready() error { return nil }

func (converter *countingConverter) Convert(_ context.Context, _ string, workDir string) (string, error) {
	converter.calls.Add(1)
	output := filepath.Join(workDir, "fixture.pdf")
	return output, os.WriteFile(output, []byte("%PDF-1.7\n%%EOF\n"), 0o600)
}

func TestConvertDOCXToPDF(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := multipartRequest(t, "report.docx", testDocxArchive(t, map[string]string{"word/document.xml": "<w:document/>"}))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("unexpected content type: %s", response.Header().Get("Content-Type"))
	}
	if !strings.Contains(response.Header().Get("Content-Disposition"), "report.pdf") {
		t.Fatalf("unexpected disposition: %s", response.Header().Get("Content-Disposition"))
	}
	if !strings.HasPrefix(response.Body.String(), "%PDF-") {
		t.Fatal("response is not a PDF")
	}
}

func TestRejectsUnsupportedExtension(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	request := multipartRequest(t, "report.rtf", []byte("fixture"))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "unsupported_input_format") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestRejectsUnsupportedTargetForDOCX(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	request := multipartRequestWithTarget(t, "report.docx", testDocxArchive(t, nil), "docx")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "unsupported_conversion") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestRejectsInvalidDOCXSignature(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	request := multipartRequest(t, "report.docx", []byte("not-a-zip"))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "input_signature_invalid") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestRejectsDOCXArchiveWithoutPackageStructure(t *testing.T) {
	converter := &countingConverter{}
	handler := NewHTTPHandler(testConfig(t), converter, nil)
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	member, err := archive.Create("readme.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := member.Write([]byte("not an office package")); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, multipartRequest(t, "report.docx", buffer.Bytes()))

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "input_archive_unsafe") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
	if converter.calls.Load() != 0 {
		t.Fatal("rejected archive reached the converter")
	}
}

func TestRejectsDOCXArchiveExpansionBombBeforeConverter(t *testing.T) {
	converter := &countingConverter{}
	handler := NewHTTPHandler(testConfig(t), converter, nil)
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	contentTypes, err := archive.Create("[Content_Types].xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := contentTypes.Write([]byte(`<?xml version="1.0"?><Types></Types>`)); err != nil {
		t.Fatal(err)
	}
	member, err := archive.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := member.Write(make([]byte, 40<<20)); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, multipartRequest(t, "report.docx", buffer.Bytes()))

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "input_archive_unsafe") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
	if converter.calls.Load() != 0 {
		t.Fatal("expansion bomb reached the converter")
	}
}

func TestRejectsDOCXArchiveBeyondMemberBudgetBeforeConverter(t *testing.T) {
	converter := &countingConverter{}
	handler := NewHTTPHandler(testConfig(t), converter, nil)
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	contentTypes, err := archive.Create("[Content_Types].xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := contentTypes.Write([]byte(`<?xml version="1.0"?><Types></Types>`)); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < maxArchiveMembers; index++ {
		member, err := archive.Create(fmt.Sprintf("word/part-%d.xml", index))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := member.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, multipartRequest(t, "report.docx", buffer.Bytes()))

	if response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "input_archive_unsafe") {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
	if converter.calls.Load() != 0 {
		t.Fatal("member-count violation reached the converter")
	}
}

func TestHealthAndReadiness(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, nil)
	for _, path := range []string{"/healthz", "/readyz"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s returned %d", path, response.Code)
		}
	}
}

type readCounter struct {
	reader io.Reader
	reads  int
}

func (counter *readCounter) Read(value []byte) (int, error) {
	counter.reads += 1
	return counter.reader.Read(value)
}

func (counter *readCounter) Close() error { return nil }

func TestConvertRequiresBearerAuthenticationBeforeBodyOrWorkspaceIO(t *testing.T) {
	for _, test := range []struct {
		name   string
		header []string
	}{
		{name: "missing"},
		{name: "wrong token", header: []string{"Bearer another-token-value-000000000000000000"}},
		{name: "duplicate", header: []string{"Bearer " + testAuthToken, "Bearer " + testAuthToken}},
		{name: "malformed", header: []string{"Bearer " + testAuthToken + " trailing"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := testConfig(t)
			handler := NewHTTPHandler(config, fakeConverter{}, nil)
			request := httptest.NewRequest(http.MethodPost, "/v1/convert", nil)
			body := &readCounter{reader: strings.NewReader("private multipart body")}
			request.Body = body
			for _, value := range test.header {
				request.Header.Add("Authorization", value)
			}
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusUnauthorized {
				t.Fatalf("expected 401, got %d", response.Code)
			}
			if body.reads != 0 {
				t.Fatalf("unauthenticated body was read %d times", body.reads)
			}
			entries, err := os.ReadDir(config.TempRoot)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("unauthenticated request created %d temporary workspaces", len(entries))
			}
		})
	}
}

func TestLibreOfficeConcurrencyRejectsBeyondBoundedQueue(t *testing.T) {
	config := testConfig(t)
	converter := newBlockingConverter()
	handler := NewHTTPHandler(config, converter, nil)
	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(firstResponse, multipartRequest(t, "first.txt", []byte("first document")))
	}()
	select {
	case <-converter.started:
	case <-time.After(time.Second):
		t.Fatal("first conversion did not start")
	}

	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, multipartRequest(t, "second.txt", []byte("second document")))
	if secondResponse.Code != http.StatusServiceUnavailable || !strings.Contains(secondResponse.Body.String(), "conversion_capacity_exhausted") {
		t.Fatalf("unexpected overload response: %d %s", secondResponse.Code, secondResponse.Body.String())
	}
	close(converter.release)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first conversion did not finish")
	}
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first conversion returned %d", firstResponse.Code)
	}
	if converter.maxActive.Load() != 1 {
		t.Fatalf("expected one active converter, got %d", converter.maxActive.Load())
	}
}

func TestTXTToDOCXConsumesBoundedRequestCapacity(t *testing.T) {
	config := testConfig(t)
	converter := newBlockingConverter()
	handler := NewHTTPHandler(config, converter, nil)
	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(firstResponse, multipartRequest(t, "first.txt", []byte("first document")))
	}()
	select {
	case <-converter.started:
	case <-time.After(time.Second):
		t.Fatal("PDF conversion did not start")
	}

	docxResponse := httptest.NewRecorder()
	handler.ServeHTTP(docxResponse, multipartRequestWithTarget(t, "second.txt", []byte("second document"), "docx"))
	if docxResponse.Code != http.StatusServiceUnavailable || !strings.Contains(docxResponse.Body.String(), "conversion_capacity_exhausted") {
		t.Fatalf("TXT to DOCX escaped the request capacity limit: %d %s", docxResponse.Code, docxResponse.Body.String())
	}
	close(converter.release)
	<-firstDone
}

func TestLibreOfficeQueueWaitsWithinConfiguredBound(t *testing.T) {
	config := testConfig(t)
	config.QueueCapacity = 1
	config.QueueTimeout = time.Second
	converter := newBlockingConverter()
	handler := NewHTTPHandler(config, converter, nil)
	responses := []*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
	done := make(chan int, 2)
	go func() {
		handler.ServeHTTP(responses[0], multipartRequest(t, "first.txt", []byte("first document")))
		done <- 0
	}()
	select {
	case <-converter.started:
	case <-time.After(time.Second):
		t.Fatal("first conversion did not start")
	}
	go func() {
		handler.ServeHTTP(responses[1], multipartRequest(t, "second.txt", []byte("second document")))
		done <- 1
	}()
	time.Sleep(20 * time.Millisecond)
	close(converter.release)
	for range 2 {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("queued conversion did not finish")
		}
	}
	for index, response := range responses {
		if response.Code != http.StatusOK {
			t.Fatalf("response %d returned %d: %s", index, response.Code, response.Body.String())
		}
	}
	if converter.maxActive.Load() != 1 {
		t.Fatalf("expected serialized converter execution, got %d", converter.maxActive.Load())
	}
}

func readZipEntry(t *testing.T, archive *zip.Reader, name string) string {
	t.Helper()
	for _, file := range archive.File {
		if file.Name != name {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		return string(content)
	}
	t.Fatalf("missing DOCX entry %s", name)
	return ""
}

type deadlineInspectingConverter struct{ t *testing.T }

func (converter deadlineInspectingConverter) Ready() error { return nil }
func (converter deadlineInspectingConverter) Convert(ctx context.Context, input, workDir string) (string, error) {
	if _, hasDeadline := ctx.Deadline(); hasDeadline {
		converter.t.Error("admitted conversion received internal deadline")
	}
	return (fakeConverter{}).Convert(ctx, input, workDir)
}
func TestAdmittedConversionHasNoInternalDurationDeadline(t *testing.T) {
	response := httptest.NewRecorder()
	NewHTTPHandler(testConfig(t), deadlineInspectingConverter{t}, nil).ServeHTTP(response, multipartRequestWithTarget(t, "document.docx", testDocxArchive(t, map[string]string{"word/document.xml": "<document/>"}), "pdf"))
	if response.Code != http.StatusOK {
		t.Fatal("normal conversion rejected")
	}
}
