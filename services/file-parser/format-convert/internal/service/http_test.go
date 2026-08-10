package service

import (
	"archive/zip"
	"bytes"
	"context"
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
		Port:              8080,
		MaxUploadBytes:    1 << 20,
		MaxOutputBytes:    2 << 20,
		ConversionTimeout: time.Second,
		MaxConcurrency:    1,
		QueueCapacity:     0,
		QueueTimeout:      100 * time.Millisecond,
		TempRoot:          t.TempDir(),
		SofficeBinary:     "soffice",
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

func TestConvertDOCXToPDF(t *testing.T) {
	handler := NewHTTPHandler(testConfig(t), fakeConverter{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	request := multipartRequest(t, "report.docx", append([]byte{'P', 'K', 3, 4}, []byte("fixture")...))
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
	request := multipartRequestWithTarget(t, "report.docx", append([]byte{'P', 'K', 3, 4}, []byte("fixture")...), "docx")
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

func TestTXTToDOCXDoesNotWaitForLibreOfficeCapacity(t *testing.T) {
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
	if docxResponse.Code != http.StatusOK || docxResponse.Header().Get("Content-Type") != docxMediaType {
		t.Fatalf("TXT to DOCX was blocked by LibreOffice capacity: %d %s", docxResponse.Code, docxResponse.Body.String())
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
