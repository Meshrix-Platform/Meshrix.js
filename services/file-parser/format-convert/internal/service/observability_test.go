package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

func TestW3CTraceContextAndHTTPRouteArePreserved(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
		sdktrace.WithSpanProcessor(recorder),
	)
	t.Cleanup(func() { _ = provider.Shutdown(context.Background()) })
	handler := NewHTTPHandler(
		testConfig(t),
		fakeConverter{},
		nil,
		WithTracerProvider(provider),
		WithMeterProvider(metricnoop.NewMeterProvider()),
		WithPropagator(propagation.TraceContext{}),
	)
	request := multipartRequestWithTarget(t, "classic.txt", []byte("public-domain text"), "docx")
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	request.Header.Set("tracestate", "vendor=value")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	wantTraceID, err := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	if err != nil {
		t.Fatal(err)
	}
	serverSpanFound := false
	for _, span := range recorder.Ended() {
		if span.SpanContext().TraceID() != wantTraceID {
			t.Fatalf("span %s did not preserve incoming trace ID", span.Name())
		}
		if span.SpanContext().TraceState().String() != "vendor=value" {
			t.Fatalf("span %s did not preserve incoming tracestate", span.Name())
		}
		if span.SpanKind() != trace.SpanKindServer {
			continue
		}
		for _, item := range span.Attributes() {
			if string(item.Key) == "http.route" && item.Value.AsString() == "/v1/convert" {
				serverSpanFound = true
			}
		}
	}
	if !serverSpanFound {
		t.Fatal("HTTP server span with standard http.route was not recorded")
	}
}

func TestPrometheusEndpointExportsStandardAndConversionMetrics(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "false")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "")
	observability, err := NewObservability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = observability.Shutdown(context.Background()) })
	handler := NewHTTPHandler(
		testConfig(t),
		fakeConverter{},
		nil,
		WithMetricsHandler(observability.MetricsHandler),
		WithTracerProvider(observability.TracerProvider),
		WithMeterProvider(observability.MeterProvider),
	)
	conversionResponse := httptest.NewRecorder()
	handler.ServeHTTP(
		conversionResponse,
		multipartRequestWithTarget(t, "classic.txt", []byte("public-domain text"), "docx"),
	)
	if conversionResponse.Code != http.StatusOK {
		t.Fatalf("conversion returned %d", conversionResponse.Code)
	}
	metricsResponse := httptest.NewRecorder()
	metricsRequest := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	metricsRequest.Header.Set("Accept", "application/openmetrics-text; version=1.0.0")
	handler.ServeHTTP(metricsResponse, metricsRequest)
	if metricsResponse.Code != http.StatusOK {
		t.Fatalf("metrics returned %d", metricsResponse.Code)
	}
	if !strings.HasPrefix(metricsResponse.Header().Get("Content-Type"), "application/openmetrics-text") {
		t.Fatalf("metrics did not negotiate OpenMetrics: %s", metricsResponse.Header().Get("Content-Type"))
	}
	payload := metricsResponse.Body.String()
	for _, metricName := range []string{"format_convert_requests", "format_convert_stage_duration", "http_server_request_duration"} {
		if !strings.Contains(payload, metricName) {
			t.Fatalf("metrics output is missing %s", metricName)
		}
	}
}

func TestOTELSDKDisabledUsesNoopProviders(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://invalid.invalid:4318")
	observability, err := NewObservability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = observability.Shutdown(context.Background()) })
	handler := NewHTTPHandler(
		testConfig(t),
		fakeConverter{},
		nil,
		WithMetricsHandler(observability.MetricsHandler),
		WithTracerProvider(observability.TracerProvider),
		WithMeterProvider(observability.MeterProvider),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, multipartRequestWithTarget(t, "classic.txt", []byte("text"), "docx"))
	metricsResponse := httptest.NewRecorder()
	handler.ServeHTTP(metricsResponse, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if strings.Contains(metricsResponse.Body.String(), "format_convert_requests") {
		t.Fatal("conversion metrics were emitted while OTEL_SDK_DISABLED=true")
	}
}
