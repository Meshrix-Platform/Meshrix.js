package service

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Each conversion sees system runtime assets and its own scratch directory only.
// Unsupported or unavailable isolation fails closed; there is no direct-exec path.
func sandboxCommand(ctx context.Context, binary, workDir string, arguments []string) (*exec.Cmd, error) {
	executable, err := converterExecutable(binary)
	if err != nil {
		return nil, err
	}
	originalWorkDir := workDir
	workDir, err = filepath.EvalSymlinks(workDir)
	if err != nil {
		return nil, err
	}
	switch runtime.GOOS {
	case "linux":
		sandbox, err := exec.LookPath("bwrap")
		if err != nil {
			return nil, errors.New("bubblewrap isolation is required")
		}
		limiter, err := exec.LookPath("prlimit")
		if err != nil {
			return nil, errors.New("prlimit resource isolation is required")
		}
		args := []string{"--unshare-all", "--die-with-parent", "--new-session", "--dir", "/proc", "--dev", "/dev", "--dir", "/tmp", "--dir", "/var", "--symlink", workDir, "/var/tmp"}
		for _, directory := range []string{"/usr/bin", "/usr/lib", "/usr/lib64", "/usr/share", "/bin", "/lib", "/lib64", "/etc/fonts", "/etc/ld.so.cache", "/etc/libreoffice"} {
			if _, err := os.Stat(directory); err == nil {
				args = append(args, "--ro-bind", directory, directory)
			}
		}
		// Custom binaries are visible by exact file, never by their parent directory.
		if !withinRuntime(executable) {
			args = append(args, "--ro-bind", executable, executable)
		}
		args = append(args, "--bind", workDir, workDir, "--chdir", workDir, "--remount-ro", "/", "--cap-drop", "ALL", "--", limiter, "--as=2147483648", "--nproc=256", "--fsize=536870912", "--", executable)
		args = append(args, arguments...)
		return exec.CommandContext(ctx, sandbox, args...), nil
	case "darwin":
		sandbox, err := exec.LookPath("sandbox-exec")
		if err != nil {
			return nil, errors.New("macOS sandbox isolation is required")
		}
		bundleRule := ""
		if index := strings.LastIndex(executable, ".app/Contents/MacOS/"); index >= 0 {
			bundleRule = " (subpath " + strconv.Quote(executable[:index+4]) + ")"
		}
		profile := `(version 1)(deny default)(allow process-fork)(allow process-exec)(allow sysctl-read (sysctl-name-regex #"^hw\.") (sysctl-name-regex #"^kern\.os"))(allow mach-lookup (global-name "com.apple.FontObjectsServer") (global-name "com.apple.fonts") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent"))(allow signal (target self))(allow file-read-metadata)(allow file-read* (literal "/"))(allow file-write* (literal "/dev/null"))(allow file-read* (subpath "/System") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/usr/share") (subpath "/bin") (subpath "/Library/Fonts") (subpath "/Library/Apple") (literal "/private/etc/localtime")  (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal ` + strconv.Quote(executable) + `)` + bundleRule + `)(allow file-read* file-write* (subpath ` + strconv.Quote(workDir) + `) (subpath ` + strconv.Quote(originalWorkDir) + `))`
		args := append([]string{"-p", profile, executable}, arguments...)
		return exec.CommandContext(ctx, sandbox, args...), nil
	default:
		return nil, errors.New("Office conversion requires supported operating-system isolation")
	}
}

func withinRuntime(filename string) bool {
	for _, directory := range []string{"/usr/bin", "/usr/lib", "/usr/lib64", "/usr/share", "/bin", "/lib", "/lib64"} {
		relative, err := filepath.Rel(directory, filename)
		if err == nil && relative != ".." && !filepath.IsAbs(relative) && len(relative) > 0 && relative[0] != '.' {
			return true
		}
	}
	return false
}

// Debian's launcher uses a splash helper that requires a new procfs mount.
// The supported headless binary needs no such helper or parent process view.
func converterExecutable(binary string) (string, error) {
	executable, err := exec.LookPath(binary)
	if err != nil {
		return "", err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return "", err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "linux" && filepath.Base(executable) == "soffice" {
		direct := filepath.Join(filepath.Dir(executable), "soffice.bin")
		if info, err := os.Stat(direct); err == nil && info.Mode().IsRegular() {
			executable = direct
		}
	}
	return executable, nil
}

func converterRuntimeEnvironment(workDir, binary string) []string {
	env := converterEnvironment(workDir)
	if runtime.GOOS == "linux" {
		executable, err := converterExecutable(binary)
		if err == nil && filepath.Base(executable) == "soffice.bin" {
			env = append(env, "LD_LIBRARY_PATH="+filepath.Dir(executable))
		}
	}
	return env
}
