# Disposable S3 fixture. Build the reviewed upstream version instead of relying
# on community binary images whose registries are no longer maintained.
FROM golang:1.24-bookworm AS build
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb
RUN cp /go/pkg/mod/github.com/minio/minio@*/LICENSE /out/LICENSE

FROM debian:bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="07c3a429bfed433e49018cb0f78a52145d4bedeb"
COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /out/LICENSE /usr/share/doc/minio/LICENSE
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
