# Speech-to-text for the ATC radio feature: whisper.cpp's HTTP server, built
# from source for the CPU it runs on (the published images need AVX2, which
# older Xeons and the Raspberry Pi don't have).
FROM debian:bookworm-slim AS build
ARG WHISPER_REF=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends git cmake g++ make ca-certificates \
 && git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# GGML_NATIVE: tune for this machine's instruction set (AVX, AVX2, NEON…).
RUN cmake -B build -DGGML_NATIVE=ON -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-server whisper-cli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/whisper-server /src/build/bin/whisper-cli /usr/local/bin/
COPY entrypoint.sh /entrypoint.sh
ENV WHISPER_MODEL=small.en WHISPER_THREADS=8
VOLUME ["/models"]
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
