package service

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigFromEnvRequiresBearerToken(t *testing.T) {
	t.Setenv("FORMAT_CONVERT_AUTH_TOKEN_FILE", "")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("expected missing token file to reject startup configuration")
	}

	t.Setenv("FORMAT_CONVERT_AUTH_TOKEN_FILE", "relative-token-file")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("expected relative token file path to reject startup configuration")
	}

	valid := "format-convert-test-token-000000000000000000000000"
	tokenFile := filepath.Join(t.TempDir(), "request-token")
	if err := os.WriteFile(tokenFile, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FORMAT_CONVERT_AUTH_TOKEN_FILE", tokenFile)
	config, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("valid token file rejected: %v", err)
	}
	if config.AuthToken != valid {
		t.Fatal("token file value was not retained by the service config")
	}
}

func TestConfigFromEnvRejectsNonRegularOrInvalidBearerTokenFiles(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("FORMAT_CONVERT_AUTH_TOKEN_FILE", directory)
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("expected a directory to reject startup configuration")
	}

	tokenFile := filepath.Join(directory, "invalid-token")
	if err := os.WriteFile(tokenFile, []byte("abcdefghijklmnopqrstuvwxyz12345\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FORMAT_CONVERT_AUTH_TOKEN_FILE", tokenFile)
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("expected a token file with a newline to reject startup configuration")
	}
}

func TestValidBearerTokenUsesToken68Characters(t *testing.T) {
	for _, test := range []struct {
		value string
		valid bool
	}{
		{value: "abcdefghijklmnopqrstuvwxyz123456", valid: true},
		{value: "abcdefghijklmnopqrstuvwxyz123456==", valid: true},
		{value: "================================", valid: false},
		{value: "abcdefghijklmnopqrstuvwxyz12345 ", valid: false},
		{value: "abcdefghijklmnopqrstuvwxyz12345=more", valid: false},
		{value: "abcdefghijklmnopqrstuvwxyz12345\n", valid: false},
	} {
		if got := validBearerToken(test.value); got != test.valid {
			t.Errorf("validBearerToken(%q) = %v, want %v", test.value, got, test.valid)
		}
	}
}
