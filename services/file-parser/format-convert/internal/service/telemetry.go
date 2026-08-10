package service

import (
	"context"
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const instrumentationName = "github.com/Meshrix-Platform/Meshrix.js/services/file-parser/format-convert"

type handlerOptions struct {
	metricsHandler http.Handler
	tracerProvider trace.TracerProvider
	meterProvider  metric.MeterProvider
	propagator     propagation.TextMapPropagator
}

type HandlerOption func(*handlerOptions)

func WithMetricsHandler(handler http.Handler) HandlerOption {
	return func(options *handlerOptions) {
		options.metricsHandler = handler
	}
}

func WithTracerProvider(provider trace.TracerProvider) HandlerOption {
	return func(options *handlerOptions) {
		options.tracerProvider = provider
	}
}

func WithMeterProvider(provider metric.MeterProvider) HandlerOption {
	return func(options *handlerOptions) {
		options.meterProvider = provider
	}
}

func WithPropagator(propagator propagation.TextMapPropagator) HandlerOption {
	return func(options *handlerOptions) {
		options.propagator = propagator
	}
}

type telemetry struct {
	tracer        trace.Tracer
	requests      metric.Int64Counter
	stageDuration metric.Float64Histogram
	active        metric.Int64UpDownCounter
	inputBytes    metric.Int64Histogram
	outputBytes   metric.Int64Histogram
}

func newTelemetry(provider metric.MeterProvider, tracerProvider trace.TracerProvider) telemetry {
	meter := provider.Meter(instrumentationName)
	requests, _ := meter.Int64Counter("format_convert.requests", metric.WithDescription("Completed conversion HTTP requests"), metric.WithUnit("{request}"))
	stageDuration, _ := meter.Float64Histogram("format_convert.stage.duration", metric.WithDescription("Conversion stage duration"), metric.WithUnit("s"))
	active, _ := meter.Int64UpDownCounter("format_convert.libreoffice.active", metric.WithDescription("LibreOffice processes currently executing"), metric.WithUnit("{process}"))
	inputBytes, _ := meter.Int64Histogram("format_convert.input.size", metric.WithDescription("Accepted conversion input size"), metric.WithUnit("By"))
	outputBytes, _ := meter.Int64Histogram("format_convert.output.size", metric.WithDescription("Completed conversion output size"), metric.WithUnit("By"))
	return telemetry{
		tracer:        tracerProvider.Tracer(instrumentationName),
		requests:      requests,
		stageDuration: stageDuration,
		active:        active,
		inputBytes:    inputBytes,
		outputBytes:   outputBytes,
	}
}

func defaultHandlerOptions() handlerOptions {
	return handlerOptions{
		tracerProvider: otel.GetTracerProvider(),
		meterProvider:  otel.GetMeterProvider(),
		propagator:     propagation.TraceContext{},
	}
}

func (telemetry telemetry) observeStage(ctx context.Context, stage, result, inputFormat, targetFormat string, startedAt time.Time) {
	telemetry.stageDuration.Record(ctx, time.Since(startedAt).Seconds(), metric.WithAttributes(
		attribute.String("format_convert.stage", stage),
		attribute.String("format_convert.result", result),
		attribute.String("format_convert.input_format", inputFormat),
		attribute.String("format_convert.target_format", targetFormat),
	))
}

func formatAttribute(extension string) string {
	switch extension {
	case ".txt":
		return "txt"
	case ".doc":
		return "doc"
	case ".docx":
		return "docx"
	default:
		return "unknown"
	}
}
