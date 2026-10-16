FROM quay.io/pypa/manylinux_2_28_aarch64@sha256:abd1230aa9e4058a74b89d27cd14ba18c0db036d7bfe6e6f219a29ea63c24eb6

ARG RUST_TOOLCHAIN=1.95.0

ENV CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    PATH=/opt/cargo/bin:/opt/python/cp313-cp313/bin:${PATH}

RUN dnf -y --setopt=install_weak_deps=False install \
      cmake \
      git \
      binutils \
      protobuf-compiler \
      pkgconf-pkg-config \
      wayland-devel \
      libxkbcommon-devel \
      libX11-devel \
      libXcursor-devel \
      libXi-devel \
      libXrandr-devel \
      libXinerama-devel \
      libXxf86vm-devel \
      mesa-libGL-devel \
      mesa-libEGL-devel \
    && dnf clean all

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}"

RUN rustup target add \
      aarch64-unknown-linux-gnu \
      aarch64-unknown-linux-musl \
      x86_64-unknown-linux-gnu \
      x86_64-unknown-linux-musl \
    && cargo install --locked --jobs 2 --root /opt/cargo --version 0.23.3 cargo-zigbuild \
    && python3.13 -m pip install --no-cache-dir ziglang==0.15.2 \
    && chmod -R a+rX /opt/cargo /opt/rustup

RUN dnf -y --installroot=/opt/meshrix-sysroot-x86_64 \
      --forcearch=x86_64 \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      install \
        glibc-devel \
        wayland-devel \
        libxkbcommon-devel \
        libX11-devel \
        libXcursor-devel \
        libXi-devel \
        libXrandr-devel \
        libXinerama-devel \
        libXxf86vm-devel \
        mesa-libGL-devel \
        mesa-libEGL-devel \
        pkgconf-pkg-config \
    && dnf clean all

RUN ln -s /opt/python/cp313-cp313/lib/python3.13/site-packages/ziglang/zig /usr/local/bin/zig

RUN curl -fsSL \
      https://github.com/protocolbuffers/protobuf/releases/download/v3.12.4/protoc-3.12.4-linux-aarch_64.zip \
      -o /tmp/protoc-3.12.4-linux-aarch_64.zip \
    && echo "30b4597db5d7c5c1c473f7c51d965890f025009917e1e02f06a6a72a44135002  /tmp/protoc-3.12.4-linux-aarch_64.zip" \
      | sha256sum --check --status \
    && mkdir -p /opt/protoc-3.12.4 \
    && python3.13 -c 'import zipfile; zipfile.ZipFile("/tmp/protoc-3.12.4-linux-aarch_64.zip").extractall("/opt/protoc-3.12.4")' \
    && chmod +x /opt/protoc-3.12.4/bin/protoc \
    && rm /tmp/protoc-3.12.4-linux-aarch_64.zip

ENV MESHRIX_LINUX_SYSROOT_X86_64=/opt/meshrix-sysroot-x86_64
ENV PROTOC=/opt/protoc-3.12.4/bin/protoc

# The manylinux base excludes documentation by default. Restore only the
# installed GUI runtime packages so packaging can select their license texts.
RUN dnf -y --setopt=tsflags= reinstall \
      libX11 \
      libX11-xcb \
      libXrender \
      libXcursor \
      libXi \
      libxcb \
      libXau \
      libXext \
      libXfixes \
      libXrandr \
      libXinerama \
      libXxf86vm \
      libwayland-client \
      libwayland-cursor \
      libwayland-egl \
      libxkbcommon \
      mesa-libGL \
      mesa-libEGL \
    && dnf -y --installroot=/opt/meshrix-sysroot-x86_64 \
      --forcearch=x86_64 \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags= \
      reinstall \
      libX11 \
      libX11-xcb \
      libXrender \
      libXcursor \
      libXi \
      libxcb \
      libXau \
      libXext \
      libXfixes \
      libXrandr \
      libXinerama \
      libXxf86vm \
      libwayland-client \
      libwayland-cursor \
      libwayland-egl \
      libxkbcommon \
      mesa-libGL \
      mesa-libEGL \
    && dnf clean all

RUN sed -i '/^tsflags=nodocs$/d' /etc/dnf/dnf.conf \
    && dnf -y --setopt=tsflags= reinstall \
      libX11-common-1.6.8-9.el8_10.noarch \
      libxcb-1.13.1-1.el8 \
    && dnf -y --setopt=tsflags= install \
      libxkbcommon-x11-0.9.1-1.el8 \
    && dnf -y --setopt=tsflags= reinstall \
      libxcb-devel-1.13.1-1.el8 \
    && dnf -y --installroot=/opt/meshrix-sysroot-x86_64 \
      --forcearch=x86_64 \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags= \
      reinstall \
      libX11-common-1.6.8-9.el8_10.noarch \
      libxcb-1.13.1-1.el8 \
    && dnf -y --installroot=/opt/meshrix-sysroot-x86_64 \
      --forcearch=x86_64 \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags= \
      install \
      libxkbcommon-x11-0.9.1-1.el8 \
    && dnf -y --installroot=/opt/meshrix-sysroot-x86_64 \
      --forcearch=x86_64 \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags= \
      reinstall \
      libxcb-devel-1.13.1-1.el8 \
    && dnf clean all
