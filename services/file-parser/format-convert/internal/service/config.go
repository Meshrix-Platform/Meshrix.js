package service

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"time"
)

const (
	defaultPort           = 8080
	defaultMaxUploadBytes = 50 << 20
	defaultMaxOutputBytes = 100 << 20
	defaultTimeout        = 120 * time.Second
	defaultQueueTimeout   = 5 * time.Second
)

type Config struct {
	Port              int
	MaxUploadBytes    int64
	MaxOutputBytes    int64
	ConversionTimeout time.Duration
	MaxConcurrency    int
	QueueCapacity     int
	QueueTimeout      time.Duration
	TempRoot          string
	SofficeBinary     string
}

func ConfigFromEnv() (Config, error) {
	port, err := positiveIntEnv("PORT", defaultPort)
	if err != nil {
		return Config{}, err
	}
	maxUploadBytes, err := positiveInt64Env("MAX_UPLOAD_BYTES", defaultMaxUploadBytes)
	if err != nil {
		return Config{}, err
	}
	maxOutputBytes, err := positiveInt64Env("MAX_OUTPUT_BYTES", defaultMaxOutputBytes)
	if err != nil {
		return Config{}, err
	}
	timeout, err := positiveDurationEnv("CONVERSION_TIMEOUT", defaultTimeout)
	if err != nil {
		return Config{}, err
	}
	maxConcurrency, err := positiveIntEnv("MAX_CONCURRENCY", runtime.GOMAXPROCS(0))
	if err != nil {
		return Config{}, err
	}
	queueCapacity, err := nonNegativeIntEnv("QUEUE_CAPACITY", maxConcurrency)
	if err != nil {
		return Config{}, err
	}
	queueTimeout, err := positiveDurationEnv("QUEUE_TIMEOUT", defaultQueueTimeout)
	if err != nil {
		return Config{}, err
	}

	tempRoot := os.Getenv("TEMP_ROOT")
	if tempRoot == "" {
		tempRoot = os.TempDir()
	}
	sofficeBinary := os.Getenv("SOFFICE_BINARY")
	if sofficeBinary == "" {
		sofficeBinary = "soffice"
	}

	return Config{
		Port:              port,
		MaxUploadBytes:    maxUploadBytes,
		MaxOutputBytes:    maxOutputBytes,
		ConversionTimeout: timeout,
		MaxConcurrency:    maxConcurrency,
		QueueCapacity:     queueCapacity,
		QueueTimeout:      queueTimeout,
		TempRoot:          tempRoot,
		SofficeBinary:     sofficeBinary,
	}, nil
}

func nonNegativeIntEnv(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	return value, nil
}

func positiveIntEnv(name string, fallback int) (int, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func positiveInt64Env(name string, fallback int64) (int64, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return value, nil
}

func positiveDurationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", name)
	}
	return value, nil
}
