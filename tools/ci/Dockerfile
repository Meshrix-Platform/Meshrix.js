FROM ghcr.io/catthehacker/ubuntu:act-24.04

# Match the local checkout owner while keeping the same non-root execution
# model as a GitHub-hosted runner. Docker access is granted separately by act.
ARG CI_UID
ARG CI_GID
RUN groupadd --non-unique --gid "$CI_GID" ci-runner \
    && useradd --no-log-init --non-unique --create-home --uid "$CI_UID" --gid "$CI_GID" --shell /bin/bash ci-runner \
    && mkdir -p /var/run/act \
    && chown "$CI_UID:$CI_GID" /var/run/act \
    && printf 'ci-runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/ci-runner \
    && chmod 0440 /etc/sudoers.d/ci-runner
USER ci-runner
