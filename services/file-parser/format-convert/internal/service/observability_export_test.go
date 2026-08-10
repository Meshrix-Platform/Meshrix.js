package service

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	collectormetric "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

func clearOTLPEnvironment(t *testing.T) {
	t.Helper()
	for _, variable := range []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_PROTOCOL",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	} {
		t.Setenv(variable, "")
	}
	t.Setenv("OTEL_SDK_DISABLED", "false")
}

func emitTrace(t *testing.T, observability *Observability) {
	t.Helper()
	_, span := observability.TracerProvider.Tracer("protocol-test").Start(context.Background(), "protocol.export")
	span.End()
}

func emitMetric(t *testing.T, observability *Observability) {
	t.Helper()
	counter, err := observability.MeterProvider.Meter("protocol-test").Int64Counter("protocol.export")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 1)
}

func shutdownObservability(t *testing.T, observability *Observability) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := observability.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestOTLPHTTPProtobufExportsTraces(t *testing.T) {
	clearOTLPEnvironment(t)
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/traces" || !strings.HasPrefix(request.Header.Get("Content-Type"), "application/x-protobuf") {
			http.Error(writer, "unexpected OTLP trace request", http.StatusBadRequest)
			return
		}
		payload, err := io.ReadAll(request.Body)
		var exportRequest collectortrace.ExportTraceServiceRequest
		if err != nil || proto.Unmarshal(payload, &exportRequest) != nil || len(exportRequest.ResourceSpans) == 0 {
			http.Error(writer, "invalid OTLP trace payload", http.StatusBadRequest)
			return
		}
		requests.Add(1)
		writer.Header().Set("Content-Type", "application/x-protobuf")
		response, _ := proto.Marshal(&collectortrace.ExportTraceServiceResponse{})
		_, _ = writer.Write(response)
	}))
	defer server.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", server.URL+"/v1/traces")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/protobuf")

	observability, err := NewObservability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	emitTrace(t, observability)
	shutdownObservability(t, observability)
	if requests.Load() == 0 {
		t.Fatal("OTLP/HTTP trace exporter sent no protobuf request")
	}
}

func TestOTLPHTTPProtobufExportsMetrics(t *testing.T) {
	clearOTLPEnvironment(t)
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/metrics" || !strings.HasPrefix(request.Header.Get("Content-Type"), "application/x-protobuf") {
			http.Error(writer, "unexpected OTLP metric request", http.StatusBadRequest)
			return
		}
		payload, err := io.ReadAll(request.Body)
		var exportRequest collectormetric.ExportMetricsServiceRequest
		if err != nil || proto.Unmarshal(payload, &exportRequest) != nil || len(exportRequest.ResourceMetrics) == 0 {
			http.Error(writer, "invalid OTLP metric payload", http.StatusBadRequest)
			return
		}
		requests.Add(1)
		writer.Header().Set("Content-Type", "application/x-protobuf")
		response, _ := proto.Marshal(&collectormetric.ExportMetricsServiceResponse{})
		_, _ = writer.Write(response)
	}))
	defer server.Close()
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", server.URL+"/v1/metrics")
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/protobuf")

	observability, err := NewObservability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	emitMetric(t, observability)
	shutdownObservability(t, observability)
	if requests.Load() == 0 {
		t.Fatal("OTLP/HTTP metric exporter sent no protobuf request")
	}
}

type grpcTraceReceiver struct {
	collectortrace.UnimplementedTraceServiceServer
	requests atomic.Int64
}

func (receiver *grpcTraceReceiver) Export(_ context.Context, request *collectortrace.ExportTraceServiceRequest) (*collectortrace.ExportTraceServiceResponse, error) {
	if len(request.ResourceSpans) > 0 {
		receiver.requests.Add(1)
	}
	return &collectortrace.ExportTraceServiceResponse{}, nil
}

type grpcMetricReceiver struct {
	collectormetric.UnimplementedMetricsServiceServer
	requests atomic.Int64
}

func (receiver *grpcMetricReceiver) Export(_ context.Context, request *collectormetric.ExportMetricsServiceRequest) (*collectormetric.ExportMetricsServiceResponse, error) {
	if len(request.ResourceMetrics) > 0 {
		receiver.requests.Add(1)
	}
	return &collectormetric.ExportMetricsServiceResponse{}, nil
}

func startOTLPGRPCServer(t *testing.T) (string, *grpcTraceReceiver, *grpcMetricReceiver) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	traceReceiver := &grpcTraceReceiver{}
	metricReceiver := &grpcMetricReceiver{}
	collectortrace.RegisterTraceServiceServer(server, traceReceiver)
	collectormetric.RegisterMetricsServiceServer(server, metricReceiver)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() {
		server.Stop()
		_ = listener.Close()
	})
	return "http://" + listener.Addr().String(), traceReceiver, metricReceiver
}

func TestOTLPGRPCExportsTraces(t *testing.T) {
	clearOTLPEnvironment(t)
	endpoint, receiver, _ := startOTLPGRPCServer(t)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", endpoint)
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "grpc")

	observability, err := NewObservability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	emitTrace(t, observability)
	shutdownObservability(t, observability)
	if receiver.requests.Load() == 0 {
		t.Fatal("OTLP/gRPC trace exporter sent no request")
	}
}

func TestOTLPGRPCExportsMetrics(t *testing.T) {
	clearOTLPEnvironment(t)
	endpoint, _, receiver := startOTLPGRPCServer(t)
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", endpoint)
	t.Setenv("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc")

	observability, err := NewObservability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	emitMetric(t, observability)
	shutdownObservability(t, observability)
	if receiver.requests.Load() == 0 {
		t.Fatal("OTLP/gRPC metric exporter sent no request")
	}
}
