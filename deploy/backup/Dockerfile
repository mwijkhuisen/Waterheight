# Backup image: the restic binary on distroless static (A§11.1, A§11.3; issue #16
# P1b). Our own image, so it is signed by release.yml like every other image the
# VPS runs. The release asset is checked against its pinned sha256.
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS restic
ARG RESTIC_VERSION=0.19.1
ADD --checksum=sha256:f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c \
  https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_amd64.bz2 \
  /tmp/restic.bz2
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 \
  && bunzip2 /tmp/restic.bz2 \
  && chmod 0755 /tmp/restic

FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3
COPY --from=restic /tmp/restic /usr/local/bin/restic
# restic buffers pack files in TMPDIR; /cache is a volume, the root file system is read-only.
ENV TMPDIR=/cache
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/restic"]
