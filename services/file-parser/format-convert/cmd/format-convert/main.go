package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Meshrix-Platform/Meshrix.js/services/file-parser/format-convert/internal/service"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With(
		"service.name", "format-convert",
		"service.namespace", "meshrix",
	)
	config, err := service.ConfigFromEnv()
	if err != nil {
		logger.Error("invalid configuration", "error", err.Error())
		os.Exit(2)
	}
	observability, err := service.NewObservability(context.Background())
	if err != nil {
		logger.Error("observability initialization failed", "error", err.Error())
		os.Exit(2)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := observability.Shutdown(shutdownCtx); err != nil {
			logger.Error("observability shutdown failed")
		}
	}()

	handler := service.NewHTTPHandler(
		config,
		service.LibreOfficeConverter{Binary: config.SofficeBinary},
		logger,
		service.WithMetricsHandler(observability.MetricsHandler),
		service.WithTracerProvider(observability.TracerProvider),
		service.WithMeterProvider(observability.MeterProvider),
	)
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", config.Port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       config.ConversionTimeout + 15*time.Second,
		WriteTimeout:      config.ConversionTimeout + 15*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logger.Info("format conversion service started", "port", config.Port, "max_concurrency", config.MaxConcurrency, "queue_capacity", config.QueueCapacity)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("format conversion service stopped unexpectedly", "error", err.Error())
		os.Exit(1)
	}
}
