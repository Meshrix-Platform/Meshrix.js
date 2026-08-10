package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	semconv "go.opentelemetry.io/otel/semconv/v1.34.0"
	"go.opentelemetry.io/otel/trace"
)

const (
	multipartOverheadAllowance = 1 << 20
)

const (
	pdfMediaType  = "application/pdf"
	docxMediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

type conversionInput struct {
	path         string
	originalName string
	extension    string
	targetFormat string
	bytes        int64
}

type conversionOutput struct {
	path      string
	fileName  string
	mediaType string
}

type HTTPService struct {
	config    Config
	converter Converter
	logger    *slog.Logger
	admission *admission
	telemetry telemetry
}

func NewHTTPHandler(config Config, converter Converter, logger *slog.Logger, functionalOptions ...HandlerOption) http.Handler {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	options := defaultHandlerOptions()
	for _, apply := range functionalOptions {
		apply(&options)
	}
	service := &HTTPService{
		config:    config,
		converter: converter,
		logger:    logger,
		admission: newAdmission(config.MaxConcurrency, config.QueueCapacity, config.QueueTimeout),
		telemetry: newTelemetry(options.meterProvider, options.tracerProvider),
	}
	applicationMux := http.NewServeMux()
	applicationMux.Handle("GET /healthz", routeHandler("/healthz", service.health))
	applicationMux.Handle("GET /readyz", routeHandler("/readyz", service.ready))
	applicationMux.Handle("POST /v1/convert", routeHandler("/v1/convert", service.convert))
	instrumented := otelhttp.NewHandler(applicationMux, "format-convert.http",
		otelhttp.WithTracerProvider(options.tracerProvider),
		otelhttp.WithMeterProvider(options.meterProvider),
		otelhttp.WithPropagators(options.propagator),
	)
	rootMux := http.NewServeMux()
	rootMux.Handle("/", instrumented)
	if options.metricsHandler != nil {
		rootMux.Handle("GET /metrics", options.metricsHandler)
	}
	return securityHeaders(rootMux)
}

func routeHandler(route string, handler http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if labeler, ok := otelhttp.LabelerFromContext(request.Context()); ok {
			labeler.Add(semconv.HTTPRoute(route))
		}
		trace.SpanFromContext(request.Context()).SetAttributes(semconv.HTTPRoute(route))
		handler.ServeHTTP(writer, request)
	})
}

func (service *HTTPService) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
}

func (service *HTTPService) ready(writer http.ResponseWriter, _ *http.Request) {
	if err := service.converter.Ready(); err != nil {
		writeError(writer, http.StatusServiceUnavailable, "converter_unavailable")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
}

func (service *HTTPService) convert(writer http.ResponseWriter, request *http.Request) {
	startedAt := time.Now()
	outcome := "error"
	errorCode := "internal_error"
	inputFormat := "unknown"
	targetFormat := "unknown"
	var inputBytes int64
	var outputBytes int64
	defer func() {
		service.recordConversionCompletion(request.Context(), startedAt, outcome, errorCode, inputFormat, targetFormat, inputBytes, outputBytes)
	}()
	fail := func(status int, code string) {
		errorCode = code
		writeError(writer, status, code)
	}
	request.Body = http.MaxBytesReader(writer, request.Body, service.config.MaxUploadBytes+multipartOverheadAllowance)

	workDir, err := os.MkdirTemp(service.config.TempRoot, "format-convert-")
	if err != nil {
		fail(http.StatusInternalServerError, "temporary_storage_unavailable")
		return
	}
	defer os.RemoveAll(workDir)

	var input conversionInput
	var status int
	var code string
	err = service.runStage(request.Context(), "multipart.receive", inputFormat, targetFormat, func(context.Context) error {
		input, status, code = receiveConversionRequest(request, workDir, service.config.MaxUploadBytes)
		if code != "" {
			return errors.New("request receive failed")
		}
		return nil
	})
	if code != "" {
		fail(status, code)
		return
	}
	inputBytes = input.bytes
	inputFormat = formatAttribute(input.extension)
	targetFormat = input.targetFormat
	service.telemetry.inputBytes.Record(request.Context(), inputBytes, metric.WithAttributes(attribute.String("format_convert.input_format", inputFormat)))
	if err := service.runStage(request.Context(), "input.validate", inputFormat, targetFormat, func(context.Context) error {
		status, code = validateConversionInput(input)
		if code != "" {
			return errors.New("input validation failed")
		}
		return nil
	}); err != nil {
		fail(status, code)
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), service.config.ConversionTimeout)
	defer cancel()
	conversionResult, err := service.convertInput(ctx, input, workDir)
	if err != nil {
		publicCode := publicErrorCode(err)
		if errors.Is(err, errAdmissionFull) {
			writer.Header().Set("Retry-After", "1")
			fail(http.StatusServiceUnavailable, "conversion_capacity_exhausted")
		} else if errors.Is(err, errAdmissionTimeout) {
			writer.Header().Set("Retry-After", "1")
			fail(http.StatusServiceUnavailable, "conversion_queue_timed_out")
		} else if errors.Is(err, context.DeadlineExceeded) {
			fail(http.StatusGatewayTimeout, "conversion_timed_out")
		} else if errors.Is(err, context.Canceled) {
			fail(http.StatusRequestTimeout, "conversion_cancelled")
		} else if errors.Is(err, ErrTextEncodingInvalid) || errors.Is(err, ErrTextControlInvalid) {
			fail(http.StatusUnsupportedMediaType, publicCode)
		} else if errors.Is(err, ErrTextLineTooLong) || errors.Is(err, ErrTextParagraphTooLong) {
			fail(http.StatusRequestEntityTooLarge, publicCode)
		} else if errors.Is(err, ErrTextEmpty) {
			fail(http.StatusBadRequest, publicCode)
		} else {
			fail(http.StatusUnprocessableEntity, "conversion_failed")
		}
		return
	}

	var output *os.File
	var info os.FileInfo
	digest := sha256.New()
	err = service.runStage(ctx, "output.validate_hash", inputFormat, targetFormat, func(context.Context) error {
		output, err = os.Open(conversionResult.path)
		if err != nil {
			return err
		}
		info, err = output.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("conversion output is invalid")
		}
		if info.Size() > service.config.MaxOutputBytes {
			return errors.New("conversion output is too large")
		}
		if _, err = io.Copy(digest, output); err != nil {
			return err
		}
		_, err = output.Seek(0, io.SeekStart)
		return err
	})
	if output != nil {
		defer output.Close()
	}
	if err != nil {
		if info != nil && info.Size() > service.config.MaxOutputBytes {
			fail(http.StatusUnprocessableEntity, "conversion_output_too_large")
		} else {
			fail(http.StatusInternalServerError, "conversion_output_invalid")
		}
		return
	}
	outputBytes = info.Size()

	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": conversionResult.fileName})
	writer.Header().Set("Content-Type", conversionResult.mediaType)
	writer.Header().Set("Content-Disposition", disposition)
	writer.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	writer.Header().Set("Digest", "sha-256="+base64.StdEncoding.EncodeToString(digest.Sum(nil)))
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(http.StatusOK)
	if err := service.runStage(ctx, "response.stream", inputFormat, targetFormat, func(context.Context) error {
		_, copyErr := io.Copy(writer, output)
		return copyErr
	}); err != nil {
		errorCode = "response_stream_failed"
		return
	}
	service.telemetry.outputBytes.Record(ctx, outputBytes, metric.WithAttributes(attribute.String("format_convert.target_format", targetFormat)))
	outcome = "ok"
	errorCode = "none"
}

func (service *HTTPService) recordConversionCompletion(
	ctx context.Context,
	startedAt time.Time,
	outcome string,
	errorCode string,
	inputFormat string,
	targetFormat string,
	inputBytes int64,
	outputBytes int64,
) {
	attributes := []attribute.KeyValue{
		attribute.String("format_convert.result", outcome),
		attribute.String("format_convert.input_format", inputFormat),
		attribute.String("format_convert.target_format", targetFormat),
	}
	if outcome != "ok" {
		attributes = append(attributes, attribute.String("error.type", errorCode))
	}
	service.telemetry.requests.Add(ctx, 1, metric.WithAttributes(attributes...))
	spanContext := trace.SpanContextFromContext(ctx)
	logAttributes := []any{
		"result", outcome,
		"error_code", errorCode,
		"input_format", inputFormat,
		"target_format", targetFormat,
		"input_bytes", inputBytes,
		"output_bytes", outputBytes,
		"duration_ms", time.Since(startedAt).Milliseconds(),
	}
	if spanContext.IsValid() {
		logAttributes = append(logAttributes, "trace_id", spanContext.TraceID().String(), "span_id", spanContext.SpanID().String())
	}
	service.logger.Log(ctx, slog.LevelInfo, "conversion request completed", logAttributes...)
}

func (service *HTTPService) convertInput(ctx context.Context, input conversionInput, workDir string) (conversionOutput, error) {
	baseName := safeBaseName(input.originalName)
	if input.extension == ".txt" {
		docxPath := filepath.Join(workDir, "input.docx")
		if err := service.runStage(ctx, "txt.docx.build", "txt", input.targetFormat, func(context.Context) error {
			return CreateDOCXFromText(input.path, docxPath)
		}); err != nil {
			return conversionOutput{}, err
		}
		if input.targetFormat == "docx" {
			return conversionOutput{path: docxPath, fileName: baseName + ".docx", mediaType: docxMediaType}, nil
		}
		var pdfPath string
		err := service.convertWithAdmission(ctx, "txt", input.targetFormat, docxPath, workDir, &pdfPath)
		return conversionOutput{path: pdfPath, fileName: baseName + ".pdf", mediaType: pdfMediaType}, err
	}
	var pdfPath string
	err := service.convertWithAdmission(ctx, formatAttribute(input.extension), input.targetFormat, input.path, workDir, &pdfPath)
	return conversionOutput{path: pdfPath, fileName: baseName + ".pdf", mediaType: pdfMediaType}, err
}

func (service *HTTPService) convertWithAdmission(
	ctx context.Context,
	inputFormat string,
	targetFormat string,
	inputPath string,
	workDir string,
	outputPath *string,
) error {
	var release func()
	if err := service.runStage(ctx, "capacity.acquire", inputFormat, targetFormat, func(stageContext context.Context) error {
		var acquireErr error
		release, acquireErr = service.admission.acquire(stageContext)
		return acquireErr
	}); err != nil {
		return err
	}
	defer release()
	activeAttributes := metric.WithAttributes(
		attribute.String("format_convert.input_format", inputFormat),
		attribute.String("format_convert.target_format", targetFormat),
	)
	service.telemetry.active.Add(ctx, 1, activeAttributes)
	defer service.telemetry.active.Add(ctx, -1, activeAttributes)
	return service.runStage(ctx, "libreoffice.exec", inputFormat, targetFormat, func(stageContext context.Context) error {
		var err error
		*outputPath, err = service.converter.Convert(stageContext, inputPath, workDir)
		return err
	})
}

func (service *HTTPService) runStage(ctx context.Context, stage, inputFormat, targetFormat string, operation func(context.Context) error) error {
	ctx, span := service.telemetry.tracer.Start(ctx, "format_convert."+stage, trace.WithAttributes(
		attribute.String("format_convert.stage", stage),
		attribute.String("format_convert.input_format", inputFormat),
		attribute.String("format_convert.target_format", targetFormat),
	))
	startedAt := time.Now()
	err := operation(ctx)
	result := "ok"
	if err != nil {
		result = "error"
		span.SetStatus(codes.Error, "stage failed")
	}
	service.telemetry.observeStage(ctx, stage, result, inputFormat, targetFormat, startedAt)
	span.End()
	return err
}

func receiveConversionRequest(request *http.Request, workDir string, maxBytes int64) (conversionInput, int, string) {
	reader, err := request.MultipartReader()
	if err != nil {
		return conversionInput{}, http.StatusBadRequest, "multipart_request_required"
	}
	var input conversionInput
	targetSeen := false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				return conversionInput{}, http.StatusRequestEntityTooLarge, "input_file_too_large"
			}
			return conversionInput{}, http.StatusBadRequest, "multipart_request_invalid"
		}
		if part.FormName() == "targetFormat" && part.FileName() == "" && !targetSeen {
			targetSeen = true
			value, readErr := io.ReadAll(io.LimitReader(part, 17))
			part.Close()
			if readErr != nil || len(value) > 16 {
				return conversionInput{}, http.StatusBadRequest, "target_format_invalid"
			}
			input.targetFormat = strings.ToLower(strings.TrimSpace(string(value)))
			continue
		}
		if part.FormName() != "file" || part.FileName() == "" || input.path != "" {
			part.Close()
			return conversionInput{}, http.StatusBadRequest, "unexpected_multipart_field"
		}
		extension := strings.ToLower(filepath.Ext(filepath.Base(part.FileName())))
		if extension != ".doc" && extension != ".docx" && extension != ".txt" {
			part.Close()
			return conversionInput{}, http.StatusUnsupportedMediaType, "unsupported_input_format"
		}
		input.path = filepath.Join(workDir, "input"+extension)
		input.extension = extension
		input.originalName = part.FileName()
		file, err := os.OpenFile(input.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			part.Close()
			return conversionInput{}, http.StatusInternalServerError, "temporary_storage_unavailable"
		}
		input.bytes, err = io.Copy(file, io.LimitReader(part, maxBytes+1))
		closeErr := file.Close()
		part.Close()
		if err != nil || closeErr != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				return conversionInput{}, http.StatusRequestEntityTooLarge, "input_file_too_large"
			}
			return conversionInput{}, http.StatusBadRequest, "upload_read_failed"
		}
		if input.bytes == 0 {
			return conversionInput{}, http.StatusBadRequest, "empty_input_file"
		}
		if input.bytes > maxBytes {
			return conversionInput{}, http.StatusRequestEntityTooLarge, "input_file_too_large"
		}
	}
	if input.path == "" {
		return conversionInput{}, http.StatusBadRequest, "file_field_required"
	}
	if input.targetFormat == "" {
		input.targetFormat = "pdf"
	}
	return input, 0, ""
}

func validateConversionInput(input conversionInput) (int, string) {
	if input.extension != ".doc" && input.extension != ".docx" && input.extension != ".txt" {
		return http.StatusUnsupportedMediaType, "unsupported_input_format"
	}
	if input.extension != ".txt" && !hasWordSignature(input.path, input.extension) {
		return http.StatusUnsupportedMediaType, "input_signature_invalid"
	}
	if input.targetFormat != "pdf" && !(input.extension == ".txt" && input.targetFormat == "docx") {
		return http.StatusBadRequest, "unsupported_conversion"
	}
	return 0, ""
}

func safeBaseName(input string) string {
	base := strings.TrimSuffix(filepath.Base(input), filepath.Ext(input))
	base = strings.Map(func(value rune) rune {
		if value < 0x20 || value == 0x7f || value == '/' || value == '\\' {
			return -1
		}
		return value
	}, base)
	runes := []rune(strings.TrimSpace(base))
	if len(runes) > 180 {
		runes = runes[:180]
	}
	if len(runes) == 0 || string(runes) == "." {
		return "converted"
	}
	return string(runes)
}

func hasWordSignature(path, extension string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	header := make([]byte, 8)
	length, err := io.ReadFull(file, header)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return false
	}
	header = header[:length]
	if extension == ".docx" {
		return len(header) >= 4 && string(header[:2]) == "PK" &&
			((header[2] == 3 && header[3] == 4) || (header[2] == 5 && header[3] == 6) || (header[2] == 7 && header[3] == 8))
	}
	legacySignature := []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}
	return len(header) >= len(legacySignature) && string(header[:len(legacySignature)]) == string(legacySignature)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(writer, request)
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

func writeError(writer http.ResponseWriter, status int, code string) {
	writeJSON(writer, status, map[string]any{"ok": false, "error": map[string]string{"code": code}})
}

func publicErrorCode(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "conversion_timed_out"
	}
	if errors.Is(err, context.Canceled) {
		return "conversion_cancelled"
	}
	if errors.Is(err, ErrTextEncodingInvalid) {
		return "text_encoding_invalid"
	}
	if errors.Is(err, ErrTextControlInvalid) {
		return "text_control_invalid"
	}
	if errors.Is(err, ErrTextLineTooLong) || errors.Is(err, ErrTextParagraphTooLong) {
		return "text_structure_too_large"
	}
	if errors.Is(err, ErrTextEmpty) {
		return "empty_input_file"
	}
	return "conversion_failed"
}
