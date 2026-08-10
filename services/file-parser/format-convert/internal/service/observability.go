package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	clientprometheus "github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otlpmetricgrpc "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	otlpmetrichttp "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	otlptracegrpc "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	otlptracehttp "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otelprometheus "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.34.0"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

type Observability struct {
	MetricsHandler http.Handler
	TracerProvider trace.TracerProvider
	MeterProvider  metric.MeterProvider
	shutdown       func(context.Context) error
}

func NewObservability(ctx context.Context) (*Observability, error) {
	registry := clientprometheus.NewRegistry()
	metricsHandler := promhttp.HandlerFor(registry, promhttp.HandlerOpts{EnableOpenMetrics: true})
	if sdkDisabled() {
		return &Observability{
			MetricsHandler: metricsHandler,
			TracerProvider: tracenoop.NewTracerProvider(),
			MeterProvider:  metricnoop.NewMeterProvider(),
			shutdown:       func(context.Context) error { return nil },
		}, nil
	}

	serviceResource, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName("format-convert"),
			attribute.String("service.namespace", "meshrix"),
		),
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
	)
	if err != nil {
		return nil, fmt.Errorf("create OpenTelemetry resource: %w", err)
	}

	prometheusExporter, err := otelprometheus.New(otelprometheus.WithRegisterer(registry))
	if err != nil {
		return nil, fmt.Errorf("create Prometheus exporter: %w", err)
	}
	metricOptions := []sdkmetric.Option{
		sdkmetric.WithResource(serviceResource),
		sdkmetric.WithReader(prometheusExporter),
		sdkmetric.WithView(durationView("http.server.request.duration")),
		sdkmetric.WithView(durationView("http.client.request.duration")),
		sdkmetric.WithView(durationView("format_convert.stage.duration")),
		sdkmetric.WithView(sizeView("http.server.request.body.size")),
		sdkmetric.WithView(sizeView("http.server.response.body.size")),
		sdkmetric.WithView(sizeView("format_convert.input.size")),
		sdkmetric.WithView(sizeView("format_convert.output.size")),
	}
	if otlpEnabled("METRICS") {
		exporter, exporterErr := newOTLPMetricExporter(ctx)
		if exporterErr != nil {
			return nil, exporterErr
		}
		metricOptions = append(metricOptions, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)))
	}
	meterProvider := sdkmetric.NewMeterProvider(metricOptions...)

	traceOptions := []sdktrace.TracerProviderOption{
		sdktrace.WithResource(serviceResource),
		sdktrace.WithSampler(sdktrace.NeverSample()),
	}
	if otlpEnabled("TRACES") {
		exporter, exporterErr := newOTLPTraceExporter(ctx)
		if exporterErr != nil {
			_ = meterProvider.Shutdown(ctx)
			return nil, exporterErr
		}
		traceOptions = []sdktrace.TracerProviderOption{
			sdktrace.WithResource(serviceResource),
			sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())),
			sdktrace.WithBatcher(exporter),
		}
	}
	tracerProvider := sdktrace.NewTracerProvider(traceOptions...)

	otel.SetMeterProvider(meterProvider)
	otel.SetTracerProvider(tracerProvider)
	otel.SetTextMapPropagator(propagation.TraceContext{})

	return &Observability{
		MetricsHandler: metricsHandler,
		TracerProvider: tracerProvider,
		MeterProvider:  meterProvider,
		shutdown: func(shutdownContext context.Context) error {
			return errors.Join(
				tracerProvider.Shutdown(shutdownContext),
				meterProvider.Shutdown(shutdownContext),
			)
		},
	}, nil
}

func (observability *Observability) Shutdown(ctx context.Context) error {
	return observability.shutdown(ctx)
}

func sdkDisabled() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_SDK_DISABLED")), "true")
}

func durationView(instrumentName string) sdkmetric.View {
	return sdkmetric.NewView(
		sdkmetric.Instrument{Name: instrumentName},
		sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
			Boundaries: []float64{0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60, 120, 300},
		}},
	)
}

func sizeView(instrumentName string) sdkmetric.View {
	return sdkmetric.NewView(
		sdkmetric.Instrument{Name: instrumentName},
		sdkmetric.Stream{Aggregation: sdkmetric.AggregationExplicitBucketHistogram{
			Boundaries: []float64{64 << 10, 128 << 10, 256 << 10, 512 << 10, 1 << 20, 2 << 20, 4 << 20, 8 << 20, 16 << 20, 32 << 20, 64 << 20, 128 << 20},
		}},
	)
}

func otlpEnabled(signal string) bool {
	if sdkDisabled() {
		return false
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_"+signal+"_ENDPOINT") != ""
}

func otlpProtocol(signal string) (string, error) {
	protocol := os.Getenv("OTEL_EXPORTER_OTLP_" + signal + "_PROTOCOL")
	if protocol == "" {
		protocol = os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL")
	}
	if protocol == "" {
		protocol = "grpc"
	}
	switch protocol {
	case "grpc", "http/protobuf":
		return protocol, nil
	default:
		return "", fmt.Errorf("unsupported OTLP %s protocol %q", strings.ToLower(signal), protocol)
	}
}

func newOTLPTraceExporter(ctx context.Context) (sdktrace.SpanExporter, error) {
	protocol, err := otlpProtocol("TRACES")
	if err != nil {
		return nil, err
	}
	if protocol == "http/protobuf" {
		return otlptracehttp.New(ctx)
	}
	return otlptracegrpc.New(ctx)
}

func newOTLPMetricExporter(ctx context.Context) (sdkmetric.Exporter, error) {
	protocol, err := otlpProtocol("METRICS")
	if err != nil {
		return nil, err
	}
	if protocol == "http/protobuf" {
		return otlpmetrichttp.New(ctx)
	}
	return otlpmetricgrpc.New(ctx)
}
