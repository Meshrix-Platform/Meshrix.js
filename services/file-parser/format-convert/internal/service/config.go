package service

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

const (
	defaultPort           = 8080
	defaultMaxUploadBytes = 50 << 20
	defaultMaxOutputBytes = 100 << 20
	defaultQueueTimeout   = 5 * time.Second
)

type Config struct {
	Port           int
	MaxUploadBytes int64
	MaxOutputBytes int64
	MaxConcurrency int
	QueueCapacity  int
	QueueTimeout   time.Duration
	TempRoot       string
	SofficeBinary  string
	AuthToken      string
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
	authToken, err := readAuthTokenFile(os.Getenv("FORMAT_CONVERT_AUTH_TOKEN_FILE"))
	if err != nil {
		return Config{}, err
	}

	return Config{
		Port:           port,
		MaxUploadBytes: maxUploadBytes,
		MaxOutputBytes: maxOutputBytes,
		MaxConcurrency: maxConcurrency,
		QueueCapacity:  queueCapacity,
		QueueTimeout:   queueTimeout,
		TempRoot:       tempRoot,
		SofficeBinary:  sofficeBinary,
		AuthToken:      authToken,
	}, nil
}

func readAuthTokenFile(tokenPath string) (string, error) {
	if tokenPath == "" || !filepath.IsAbs(tokenPath) {
		return "", errors.New("FORMAT_CONVERT_AUTH_TOKEN_FILE must be an absolute path to a bearer token file")
	}
	file, err := os.Open(tokenPath)
	if err != nil {
		return "", errors.New("FORMAT_CONVERT_AUTH_TOKEN_FILE must identify a readable bearer token file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < 32 || info.Size() > 512 {
		return "", errors.New("FORMAT_CONVERT_AUTH_TOKEN_FILE must identify a regular file containing a 32-to-512-byte bearer token")
	}
	tokenBytes, err := io.ReadAll(io.LimitReader(file, 513))
	defer func() {
		for index := range tokenBytes {
			tokenBytes[index] = 0
		}
	}()
	if err != nil || !validBearerToken(string(tokenBytes)) {
		return "", errors.New("FORMAT_CONVERT_AUTH_TOKEN_FILE must contain a 32-to-512-byte bearer token")
	}
	return string(tokenBytes), nil
}

func validBearerToken(token string) bool {
	if len(token) < 32 || len(token) > 512 {
		return false
	}
	padding := false
	contentLength := 0
	for index := 0; index < len(token); index++ {
		value := token[index]
		if value == '=' {
			padding = true
			continue
		}
		if padding {
			return false
		}
		if (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
			(value >= '0' && value <= '9') || stringsContainsTokenSymbol(value) {
			contentLength++
			continue
		}
		return false
	}
	return contentLength > 0
}

func stringsContainsTokenSymbol(value byte) bool {
	switch value {
	case '-', '.', '_', '~', '+', '/':
		return true
	default:
		return false
	}
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
