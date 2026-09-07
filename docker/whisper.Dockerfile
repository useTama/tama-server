# whisper.cpp's HTTP server, built from source and shipped with one model.
# Pinned by tag so a rebuild is the same server, not whatever main is today.
FROM debian:bookworm-slim AS build

ARG WHISPER_REF=v1.7.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends git build-essential cmake ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggerganov/whisper.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_SERVER=ON \
 && cmake --build build -j"$(nproc)" --target whisper-server

FROM debian:bookworm-slim

# ggml-small is the balance point on a CPU box. Swap to ggml-base.bin on a
# 1 GB machine; large-v3 wants a GPU.
ARG MODEL=ggml-small.bin
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /models \
 && curl -fL -o /models/model.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}"

COPY --from=build /src/build/bin/whisper-server /usr/local/bin/whisper-server
COPY --from=build /src/build/src/libwhisper.so* /usr/local/lib/
COPY --from=build /src/build/ggml/src/libggml*.so* /usr/local/lib/
RUN ldconfig

EXPOSE 8081
CMD ["whisper-server", "--model", "/models/model.bin", "--host", "0.0.0.0", "--port", "8081"]
