ARG MANYLINUX_IMAGE=
# The aarch64 default keeps a bare `docker build` pinned; the build script
# always passes the digest for the detected daemon architecture.
FROM ${MANYLINUX_IMAGE:-quay.io/pypa/manylinux_2_28_aarch64@sha256:abd1230aa9e4058a74b89d27cd14ba18c0db036d7bfe6e6f219a29ea63c24eb6}

ARG RUST_TOOLCHAIN=1.95.0
ARG CROSS_ARCH=x86_64
ARG PROTOC_PACKAGE=protoc-3.12.4-linux-aarch_64.zip
ARG PROTOC_SHA256=30b4597db5d7c5c1c473f7c51d965890f025009917e1e02f06a6a72a44135002

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

# The host dnf.conf ships tsflags=nodocs and --setopt=tsflags=... appends
# rather than replaces, so nodocs must be removed before any sysroot
# transaction or every %doc file (including the license texts packaging
# collects) is stripped from the installroot.
RUN sed -i '/^tsflags=nodocs$/d' /etc/dnf/dnf.conf

# `filesystem` must land first: its /lib64 entry is a symlink and rpm cannot
# replace a real directory created by an earlier package in one transaction.
RUN dnf -y --installroot=/opt/meshrix-sysroot-${CROSS_ARCH} \
      --forcearch=${CROSS_ARCH} \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=noscripts \
      install filesystem \
    && dnf -y --installroot=/opt/meshrix-sysroot-${CROSS_ARCH} \
      --forcearch=${CROSS_ARCH} \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=noscripts \
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
      "https://github.com/protocolbuffers/protobuf/releases/download/v3.12.4/${PROTOC_PACKAGE}" \
      -o "/tmp/${PROTOC_PACKAGE}" \
    && echo "${PROTOC_SHA256}  /tmp/${PROTOC_PACKAGE}" \
      | sha256sum --check --status \
    && mkdir -p /opt/protoc-3.12.4 \
    && python3.13 -c "import zipfile; zipfile.ZipFile('/tmp/${PROTOC_PACKAGE}').extractall('/opt/protoc-3.12.4')" \
    && chmod +x /opt/protoc-3.12.4/bin/protoc \
    && rm "/tmp/${PROTOC_PACKAGE}"

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
    && dnf -y --installroot=/opt/meshrix-sysroot-${CROSS_ARCH} \
      --forcearch=${CROSS_ARCH} \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=noscripts \
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

# The restore specs name explicit NEVRAs bound to the installed set of the
# pinned base image: `rpm -q` expansion keeps every package deliberate and
# reviewable without a version literal that silently rots when EL8 publishes
# a point release. libxkbcommon-x11 must match its sibling libxkbcommon
# (same source rpm), so its spec derives from the installed V-R. A missing
# package fails the `rpm -q` probe loudly instead of expanding to nothing.
RUN rpm -q libX11-common libxcb libxcb-devel libxkbcommon \
    && rpm --root=/opt/meshrix-sysroot-${CROSS_ARCH} -q \
      libX11-common libxcb libxcb-devel libxkbcommon \
    && dnf -y --setopt=tsflags= reinstall \
      $(rpm -q libX11-common libxcb) \
    && dnf -y --setopt=tsflags= install \
      $(rpm -q libxkbcommon | sed 's/^libxkbcommon-/libxkbcommon-x11-/') \
    && dnf -y --setopt=tsflags= reinstall \
      $(rpm -q libxcb-devel) \
    && dnf -y --installroot=/opt/meshrix-sysroot-${CROSS_ARCH} \
      --forcearch=${CROSS_ARCH} \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=noscripts \
      reinstall \
      $(rpm --root=/opt/meshrix-sysroot-${CROSS_ARCH} -q libX11-common libxcb) \
    && dnf -y --installroot=/opt/meshrix-sysroot-${CROSS_ARCH} \
      --forcearch=${CROSS_ARCH} \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=noscripts \
      install \
      $(rpm --root=/opt/meshrix-sysroot-${CROSS_ARCH} -q libxkbcommon \
        | sed 's/^libxkbcommon-/libxkbcommon-x11-/') \
    && dnf -y --installroot=/opt/meshrix-sysroot-${CROSS_ARCH} \
      --forcearch=${CROSS_ARCH} \
      --releasever=8 \
      --setopt=install_weak_deps=False \
      --setopt=tsflags=noscripts \
      reinstall \
      $(rpm --root=/opt/meshrix-sysroot-${CROSS_ARCH} -q libxcb-devel) \
    && dnf clean all
