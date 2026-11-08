# Build from the repository root:  docker build -f virtual-kubelet/Dockerfile .
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal/ internal/
COPY virtual-kubelet/ virtual-kubelet/
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/sheeternetes-vk ./virtual-kubelet

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/sheeternetes-vk /sheeternetes-vk
USER 65532:65532
ENTRYPOINT ["/sheeternetes-vk"]
