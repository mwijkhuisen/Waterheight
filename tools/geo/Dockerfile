# Geo tool image (P6a, ADR-0012): libosmium + osmium-tool and tippecanoe, built from source tag tarballs
# and checked against the sha256 pinned below (the precedent is fetch-assets.ts's codeload pin). It is built in
# CI by geo.yml (`docker build -t rws-geo-tools:local -f tools/geo/Dockerfile tools/geo`) and run there with
# `--network none --cap-drop ALL --read-only`. osmium-tool is GPL-3.0: it is built and used in CI only, and
# this image is never pushed, uploaded or released (ADR-0012), so nothing is distributed. libosmium (BSL-1.0) is
# header-only. protozero, nlohmann-json, boost and the compression libraries come from Debian's signed apt
# and are not version-pinned (risk register). The base is the BOM's node image, pinned by digest.
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
ARG LIBOSMIUM_VERSION=2.23.1
ARG LIBOSMIUM_SHA256=eb47d8163396c73870dbf27819dcadda0c56f0191935c4f8659d1e61b261552f
ARG OSMIUM_VERSION=1.19.1
ARG OSMIUM_SHA256=e629d2f3e500ffa5df6f1b1689161ab3dea3a82f66beec2b453a74b8d782f949
ARG TIPPECANOE_VERSION=2.79.0
ARG TIPPECANOE_SHA256=b0fd9df49b6efc988288ea48774822c6de19eb48428017f27ee0b3b01d44f05d
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl cmake make g++ \
    libboost-program-options-dev libprotozero-dev nlohmann-json3-dev \
    libexpat1-dev libbz2-dev zlib1g-dev liblz4-dev libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# libosmium is header-only: only its include directory is kept.
RUN set -eu \
  && curl --proto '=https' -fsSL -o libosmium.tar.gz \
    "https://codeload.github.com/osmcode/libosmium/tar.gz/refs/tags/v${LIBOSMIUM_VERSION}" \
  && echo "${LIBOSMIUM_SHA256}  libosmium.tar.gz" | sha256sum -c - \
  && mkdir libosmium && tar -xzf libosmium.tar.gz -C libosmium --strip-components=1 \
  && mkdir -p /opt/libosmium && cp -r libosmium/include /opt/libosmium/include \
  && rm -rf libosmium libosmium.tar.gz
RUN set -eu \
  && curl --proto '=https' -fsSL -o osmium-tool.tar.gz \
    "https://codeload.github.com/osmcode/osmium-tool/tar.gz/refs/tags/v${OSMIUM_VERSION}" \
  && echo "${OSMIUM_SHA256}  osmium-tool.tar.gz" | sha256sum -c - \
  && mkdir osmium-tool && tar -xzf osmium-tool.tar.gz -C osmium-tool --strip-components=1 \
  && cmake -S osmium-tool -B osmium-tool/build \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
    -DOSMIUM_INCLUDE_DIR=/opt/libosmium/include \
  && cmake --build osmium-tool/build -j"$(nproc)" \
  && mkdir -p /out/bin \
  && install -m 0755 osmium-tool/build/src/osmium /out/bin/osmium \
  && rm -rf osmium-tool osmium-tool.tar.gz
# tippecanoe is not used until P6b; it is built here so that the image is the one tool image.
RUN set -eu \
  && curl --proto '=https' -fsSL -o tippecanoe.tar.gz \
    "https://codeload.github.com/felt/tippecanoe/tar.gz/refs/tags/${TIPPECANOE_VERSION}" \
  && echo "${TIPPECANOE_SHA256}  tippecanoe.tar.gz" | sha256sum -c - \
  && mkdir tippecanoe && tar -xzf tippecanoe.tar.gz -C tippecanoe --strip-components=1 \
  && make -C tippecanoe -j"$(nproc)" tippecanoe tippecanoe-decode tile-join \
  && for b in tippecanoe tippecanoe-decode tile-join; do install -m 0755 "tippecanoe/$b" "/out/bin/$b"; done \
  && rm -rf tippecanoe tippecanoe.tar.gz
# Fail the build, not a later run: right version, every shared library resolves.
RUN /out/bin/osmium --version | grep -q "osmium version ${OSMIUM_VERSION}" \
  && ! ldd /out/bin/* | grep -q "not found" \
  && ldd /out/bin/osmium | grep -q "libboost_program_options.so.1.83.0"

# Runtime: the binaries and their shared libraries only. 1.83.0 is the Boost that Debian trixie's
# libboost-program-options-dev depends on (the check above fails the build if that ever moves).
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libboost-program-options1.83.0 libexpat1 libbz2-1.0 zlib1g liblz4-1 libsqlite3-0 libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/bin/ /usr/local/bin/
USER 65532:65532
WORKDIR /work
ENTRYPOINT []
CMD ["osmium", "--version"]
