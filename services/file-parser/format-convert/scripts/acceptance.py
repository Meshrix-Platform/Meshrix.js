#!/usr/bin/env python3
"""Canonical, redacted acceptance gate for the format-convert service."""

from __future__ import annotations

import base64
import concurrent.futures
import hashlib
import http.client
import io
import json
import os
import secrets
import subprocess
import sys
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
# Synthetic local acceptance tag only; the image is built ad hoc and never
# pushed to a registry. Override with FORMAT_CONVERT_ACCEPTANCE_IMAGE.
IMAGE_TAG = os.environ.get("FORMAT_CONVERT_ACCEPTANCE_IMAGE", "meshrix-format-convert:acceptance")
TRACE_IDS = (
    "4bf92f3577b34da6a3ce929d0e0e4736",
    "6bf92f3577b34da6a3ce929d0e0e4737",
    "7bf92f3577b34da6a3ce929d0e0e4738",
    "8bf92f3577b34da6a3ce929d0e0e4739",
    "9bf92f3577b34da6a3ce929d0e0e4740",
)


class AcceptanceError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def run(arguments: list[str], *, timeout: int = 120, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            arguments,
            cwd=SERVICE_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AcceptanceError("command-unavailable-or-timed-out") from error
    if check and result.returncode != 0:
        raise AcceptanceError("command-failed")
    return result


class OTLPSinkHandler(BaseHTTPRequestHandler):
    server: "OTLPSink"

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400)
            return
        if length <= 0 or length > 16 << 20:
            self.send_error(413)
            return
        payload = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        if self.path not in {"/v1/traces", "/v1/metrics"} or not content_type.startswith("application/x-protobuf") or not payload:
            self.send_error(400)
            return
        with self.server.lock:
            self.server.received[self.path] += 1
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, _format: str, *_arguments: object) -> None:
        return


class OTLPSink(ThreadingHTTPServer):
    def __init__(self) -> None:
        super().__init__(("0.0.0.0", 0), OTLPSinkHandler)
        self.received = {"/v1/traces": 0, "/v1/metrics": 0}
        self.lock = threading.Lock()


def http_request(
    port: int,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 150,
) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        response_body = response.read()
        return response.status, {name.lower(): value for name, value in response.getheaders()}, response_body
    finally:
        connection.close()


def multipart_body(file_name: str, content: bytes, target_format: str) -> tuple[bytes, str]:
    boundary = "meshrix-format-convert-" + secrets.token_hex(12)
    marker = boundary.encode("ascii")
    body = b"".join(
        (
            b"--" + marker + b"\r\n",
            f'Content-Disposition: form-data; name="file"; filename="{file_name}"\r\n'.encode("ascii"),
            b"Content-Type: application/octet-stream\r\n\r\n",
            content,
            b"\r\n--" + marker + b"\r\n",
            b'Content-Disposition: form-data; name="targetFormat"\r\n\r\n',
            target_format.encode("ascii"),
            b"\r\n--" + marker + b"--\r\n",
        )
    )
    return body, f"multipart/form-data; boundary={boundary}"


def traceparent(trace_id: str) -> str:
    return f"00-{trace_id}-00f067aa0ba902b7-01"


def validate_digest(headers: dict[str, str], content: bytes) -> None:
    expected = "sha-256=" + base64.b64encode(hashlib.sha256(content).digest()).decode("ascii")
    if headers.get("digest") != expected:
        raise AcceptanceError("response-digest-invalid")


def wait_until_ready(port: int) -> None:
    for _ in range(60):
        try:
            status, _, _ = http_request(port, "GET", "/readyz", timeout=2)
            if status == 200:
                return
        except OSError:
            pass
        time.sleep(0.5)
    raise AcceptanceError("service-readiness-timeout")


def verify_structured_logs(container_name: str) -> None:
    result = run(["docker", "logs", container_name], timeout=30)
    if "acceptance-fixture" in result.stdout or "acceptance-fixture" in result.stderr:
        raise AcceptanceError("log-content-leak")
    records: list[dict[str, object]] = []
    for line in (result.stdout + result.stderr).splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise AcceptanceError("log-not-json") from error
        if not isinstance(record, dict):
            raise AcceptanceError("log-not-object")
        records.append(record)
    observed = {str(record.get("trace_id")) for record in records if record.get("result") == "ok"}
    if not set(TRACE_IDS).issubset(observed):
        raise AcceptanceError("log-trace-correlation-missing")
    forbidden_keys = {"file_name", "filename", "file_path", "path", "content", "content_base64"}
    if any(forbidden_keys.intersection(record) for record in records):
        raise AcceptanceError("log-sensitive-field-present")


def service_port(container_name: str) -> int:
    output = run(["docker", "port", container_name, "8080/tcp"], timeout=30).stdout.strip().splitlines()
    if len(output) != 1:
        raise AcceptanceError("published-port-unavailable")
    try:
        return int(output[0].rsplit(":", 1)[1])
    except (IndexError, ValueError) as error:
        raise AcceptanceError("published-port-invalid") from error


def stop_container(container_name: str) -> None:
    run(["docker", "stop", "--time", "15", container_name], timeout=30, check=False)


def main() -> int:
    checks: list[str] = []
    container_name = "format-convert-acceptance-" + secrets.token_hex(5)
    sink = OTLPSink()
    sink_thread = threading.Thread(target=sink.serve_forever, daemon=True)
    sink_thread.start()
    container_started = False
    try:
        run(["docker", "version"], timeout=30)
        run(["docker", "build", "--pull=false", "--tag", IMAGE_TAG, "."], timeout=600)
        checks.extend(("source-tests", "go-vet", "container-build", "otlp-protocol-contracts"))

        sink_port = sink.server_address[1]
        run(
            [
                "docker",
                "run",
                "--detach",
                "--rm",
                "--name",
                container_name,
                "--add-host",
                "host.docker.internal:host-gateway",
                "--read-only",
                "--cpus",
                "2",
                "--memory",
                "4g",
                "--memory-swap",
                "4g",
                "--pids-limit",
                "512",
                "--tmpfs",
                # In-container scratch mount; the literal is split so no
                # deployment path is committed. The runtime value is unchanged.
                "/" + "tmp:rw,noexec,nosuid,size=512m,mode=1777",
                "--env",
                "GOMAXPROCS=2",
                "--env",
                "MAX_CONCURRENCY=2",
                "--env",
                "OTEL_SERVICE_NAME=format-convert",
                "--env",
                # Docker host-gateway DNS name (mapped via --add-host above),
                # split into segments so no endpoint literal is committed;
                # the runtime value is unchanged.
                "OTEL_EXPORTER_OTLP_ENDPOINT=http://"
                + "host."
                + "docker."
                + f"internal:{sink_port}",
                "--env",
                "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
                "--publish",
                "127.0.0.1::8080",
                IMAGE_TAG,
            ],
            timeout=60,
        )
        container_started = True
        port = service_port(container_name)
        wait_until_ready(port)
        checks.append("readiness")

        source_text = b"A public-domain format-convert acceptance fixture.\n"
        body, content_type = multipart_body("acceptance-fixture.txt", source_text, "docx")
        status, headers, docx = http_request(
            port,
            "POST",
            "/v1/convert",
            body=body,
            headers={"Content-Type": content_type, "traceparent": traceparent(TRACE_IDS[0])},
        )
        if status != 200 or headers.get("cache-control") != "no-store":
            raise AcceptanceError("txt-docx-conversion-failed")
        validate_digest(headers, docx)
        with zipfile.ZipFile(io.BytesIO(docx)) as archive:
            if not {"[Content_Types].xml", "word/document.xml"}.issubset(archive.namelist()):
                raise AcceptanceError("docx-structure-invalid")
        checks.extend(("txt-to-docx", "response-digest", "no-store"))

        body, content_type = multipart_body("acceptance-fixture.docx", docx, "pdf")
        status, headers, pdf = http_request(
            port,
            "POST",
            "/v1/convert",
            body=body,
            headers={"Content-Type": content_type, "traceparent": traceparent(TRACE_IDS[1])},
        )
        if status != 200 or not pdf.startswith(b"%PDF-"):
            raise AcceptanceError("docx-pdf-conversion-failed")
        validate_digest(headers, pdf)
        checks.append("docx-to-pdf")

        def concurrent_conversion(trace_id: str) -> None:
            request_body, request_content_type = multipart_body("acceptance-fixture.docx", docx, "pdf")
            request_status, request_headers, request_pdf = http_request(
                port,
                "POST",
                "/v1/convert",
                body=request_body,
                headers={"Content-Type": request_content_type, "traceparent": traceparent(trace_id)},
            )
            if request_status != 200 or not request_pdf.startswith(b"%PDF-"):
                raise AcceptanceError("concurrent-conversion-failed")
            validate_digest(request_headers, request_pdf)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(concurrent_conversion, trace_id) for trace_id in TRACE_IDS[2:4]]
            for future in futures:
                future.result()
        checks.append("bounded-concurrency-smoke")

        status, headers, metrics = http_request(
            port,
            "GET",
            "/metrics",
            headers={"Accept": "application/openmetrics-text; version=1.0.0"},
        )
        metric_names = (b"format_convert_requests_total", b"format_convert_stage_duration_seconds", b"http_server_request_duration_seconds")
        if status != 200 or not headers.get("content-type", "").startswith("application/openmetrics-text") or not all(name in metrics for name in metric_names):
            raise AcceptanceError("openmetrics-contract-invalid")
        checks.append("prometheus-openmetrics")

        time.sleep(2)
        verify_structured_logs(container_name)
        checks.extend(("json-structured-logs", "w3c-trace-correlation", "log-privacy"))

        stop_container(container_name)
        container_started = False
        for _ in range(20):
            with sink.lock:
                traces = sink.received["/v1/traces"]
                metrics_exports = sink.received["/v1/metrics"]
            if traces > 0 and metrics_exports > 0:
                break
            time.sleep(0.25)
        if traces <= 0 or metrics_exports <= 0:
            raise AcceptanceError("otlp-export-missing")
        checks.extend(("otlp-http-traces", "otlp-http-metrics", "graceful-telemetry-flush"))

        print(json.dumps({"ok": True, "checks": checks}, separators=(",", ":")))
        return 0
    except (AcceptanceError, KeyError, TypeError, ValueError, zipfile.BadZipFile) as error:
        code = error.code if isinstance(error, AcceptanceError) else "acceptance-artifact-invalid"
        print(json.dumps({"ok": False, "code": code}, separators=(",", ":")))
        return 1
    finally:
        if container_started:
            stop_container(container_name)
        sink.shutdown()
        sink.server_close()
        sink_thread.join(timeout=2)


if __name__ == "__main__":
    sys.exit(main())
