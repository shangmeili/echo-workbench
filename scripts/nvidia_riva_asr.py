#!/usr/bin/env python3
import argparse
import json
import os
import wave


def fail(message, code=1):
    print(json.dumps({"error": message}, ensure_ascii=False))
    raise SystemExit(code)


def duration_to_seconds(value):
    seconds = getattr(value, "seconds", 0) or 0
    nanos = getattr(value, "nanos", 0) or 0
    return float(seconds) + float(nanos) / 1_000_000_000


def load_audio(file_path, riva_client):
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".wav":
        try:
            with wave.open(file_path, "rb") as wav_file:
                frames = wav_file.readframes(wav_file.getnframes())
                return {
                    "audio": frames,
                    "encoding": riva_client.AudioEncoding.LINEAR_PCM,
                    "sample_rate_hertz": wav_file.getframerate(),
                    "audio_channel_count": wav_file.getnchannels(),
                }
        except wave.Error:
            pass
    with open(file_path, "rb") as handle:
        audio = handle.read()
    return {
        "audio": audio,
        "encoding": riva_client.AudioEncoding.FLAC if ext == ".flac" else None,
        "sample_rate_hertz": 0,
        "audio_channel_count": 1,
    }


def main():
    parser = argparse.ArgumentParser(description="NVIDIA Riva hosted ASR adapter")
    parser.add_argument("--file", required=True)
    parser.add_argument("--function-id", required=True)
    parser.add_argument("--language-code", default="multi")
    parser.add_argument("--server", default="grpc.nvcf.nvidia.com:443")
    parser.add_argument("--translate", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if not api_key:
        fail("缺少 NVIDIA API Key。")

    try:
        import riva.client
    except ModuleNotFoundError:
        fail("缺少 NVIDIA Riva Python 客户端。请在服务端环境安装 nvidia-riva-client。", 2)

    try:
        audio_payload = load_audio(args.file, riva.client)

        auth = riva.client.Auth(
            uri=args.server,
            use_ssl=True,
            metadata_args=[
                ["function-id", args.function_id],
                ["authorization", "Bearer " + api_key],
            ],
        )
        service = riva.client.ASRService(auth)
        custom_configuration = "task:translate" if args.translate else ""
        config_kwargs = {
            "language_code": args.language_code,
            "max_alternatives": 1,
            "enable_automatic_punctuation": True,
            "enable_word_time_offsets": True,
            "audio_channel_count": audio_payload["audio_channel_count"],
            "custom_configuration": custom_configuration,
        }
        if audio_payload["encoding"] is not None:
            config_kwargs["encoding"] = audio_payload["encoding"]
        if audio_payload["sample_rate_hertz"]:
            config_kwargs["sample_rate_hertz"] = audio_payload["sample_rate_hertz"]
        config = riva.client.RecognitionConfig(**config_kwargs)
        response = service.offline_recognize(audio_payload["audio"], config)
    except Exception as exc:
        fail(str(exc), 3)

    transcripts = []
    words = []
    for result in response.results:
        if not result.alternatives:
            continue
        alternative = result.alternatives[0]
        if alternative.transcript:
            transcripts.append(alternative.transcript)
        for word in alternative.words:
            words.append(
                {
                    "word": word.word,
                    "start": duration_to_seconds(word.start_time),
                    "end": duration_to_seconds(word.end_time),
                }
            )

    print(
        json.dumps(
            {
                "text": " ".join(part.strip() for part in transcripts if part.strip()).strip(),
                "words": words,
                "provider": "nvidia-riva",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
