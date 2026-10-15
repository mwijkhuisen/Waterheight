# Backup image: the restic binary on distroless static (A§11.1, A§11.3; issue #16
# P1b). Our own image, so it is signed by release.yml like every other image the
# VPS runs.
# #131 (R-095): restic is built from its release module, not taken as the release
# binary, because that binary carries High Grype findings (Go stdlib, x/net,
# x/crypto, x/text, gRPC) that no restic release fixes yet. The Go tarball is
# sha256-pinned, the module is checked against its pinned go.sum hash, and every
# module download against the Go checksum database. GO_FIXES are the fixed
# versions (each at least 7 days old). Back to the release binary once one clears
# Grype. The Go stage from ARG GO_VERSION to ARG GO_FIXES is the same text as in
# deploy/server/Dockerfile (test/check-bom.test.ts).
FROM node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS restic
ARG GO_VERSION=1.27.2
ADD --checksum=sha256:ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5 \
  https://dl.google.com/go/go${GO_VERSION}.linux-amd64.tar.gz \
  /tmp/go.tar.gz
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && tar -C /usr/local -xzf /tmp/go.tar.gz \
  && mkdir -p /gosrc /gobin
# Only the Go module proxy, every download checked against the checksum database,
# whatever the base image or a later layer sets; no toolchain download, no cgo.
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS= \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOPRIVATE= GONOPROXY= GONOSUMDB= GOINSECURE=
ARG GO_FIXES="golang.org/x/net@v0.60.0 golang.org/x/crypto@v0.57.0 golang.org/x/text@v0.42.0 google.golang.org/grpc@v1.83.2 go.opentelemetry.io/otel/sdk@v1.44.0"
ARG RESTIC_VERSION=0.19.1
# The upstream release flags (helpers/build-release-binaries) without `selfupdate`:
# the image never replaces its own binary.
RUN m=github.com/restic/restic@v${RESTIC_VERSION} \
  && go mod download -json "$m" | grep -F '"Sum": "h1:LQKkar5/gYxay1OCokAWPBNiLr1lTpt4fhdM4GWqSlY="' \
  && cp -r "$(go env GOMODCACHE)/$m" /gosrc/restic && chmod -R u+w /gosrc/restic && cd /gosrc/restic \
  && go get ${GO_FIXES} \
  && go build -trimpath -tags disable_grpc_modules -ldflags '-s -w' -o /gobin/restic ./cmd/restic

FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
COPY --from=restic /gobin/restic /usr/local/bin/restic
# restic buffers pack files in TMPDIR; /cache is a volume, the root file system is read-only.
ENV TMPDIR=/cache
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/restic"]
