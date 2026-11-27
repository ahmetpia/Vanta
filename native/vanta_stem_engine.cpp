// VANTA Native HTDemucs 4-Stem Separation Engine (ONNX Runtime + DirectML / CPU Fallback)
// Build (MSVC x64): cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /DUNICODE /D_UNICODE /Iort\include vanta_stem_engine.cpp ort\lib\onnxruntime.lib /Fe:..\bin\vanta-stem-engine.exe

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <io.h>
#include <fcntl.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#pragma warning(push, 3)
#include "onnxruntime_cxx_api.h"
#include "dml_provider_factory.h"
#pragma warning(pop)

namespace {

constexpr uint32_t TARGET_SAMPLE_RATE = 44100;
constexpr size_t TARGET_CHANNELS = 2;
constexpr size_t SEGMENT_SAMPLES = 343980; // 7.8s @ 44100 Hz
constexpr size_t OVERLAP_SAMPLES = SEGMENT_SAMPLES / 4; // 85995
constexpr size_t STRIDE_SAMPLES = SEGMENT_SAMPLES - OVERLAP_SAMPLES; // 257985
constexpr size_t NUM_STEMS = 4;
constexpr std::array<const char*, NUM_STEMS> STEM_NAMES = { "drums", "bass", "other", "vocals" };

std::string EscapeJson(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
                break;
        }
    }
    return out;
}

std::string WideToUtf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int needed = WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (needed <= 1) return "";
    std::string out(static_cast<size_t>(needed - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wstr.c_str(), -1, out.data(), needed, nullptr, nullptr);
    return out;
}

void EmitJsonLine(const std::string& json) {
    std::fwrite(json.data(), 1, json.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void EmitError(const std::string& msg) {
    EmitJsonLine("{\"type\":\"error\",\"error\":\"" + EscapeJson(msg) + "\"}");
}

uint16_t ReadU16LE(const uint8_t* p) {
    return static_cast<uint16_t>(p[0] | (static_cast<uint16_t>(p[1]) << 8));
}

uint32_t ReadU32LE(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

int32_t ReadS24LE(const uint8_t* p) {
    int32_t v = static_cast<int32_t>(p[0]) |
                (static_cast<int32_t>(p[1]) << 8) |
                (static_cast<int32_t>(p[2]) << 16);
    if (v & 0x800000) v |= static_cast<int32_t>(0xFF000000u);
    return v;
}

void WriteU16LE(std::ofstream& out, uint16_t v) {
    uint8_t b[2] = { static_cast<uint8_t>(v & 0xFF), static_cast<uint8_t>((v >> 8) & 0xFF) };
    out.write(reinterpret_cast<const char*>(b), 2);
}

void WriteU32LE(std::ofstream& out, uint32_t v) {
    uint8_t b[4] = {
        static_cast<uint8_t>(v & 0xFF),
        static_cast<uint8_t>((v >> 8) & 0xFF),
        static_cast<uint8_t>((v >> 16) & 0xFF),
        static_cast<uint8_t>((v >> 24) & 0xFF)
    };
    out.write(reinterpret_cast<const char*>(b), 4);
}

struct PlanarStereoAudio {
    std::vector<float> left;
    std::vector<float> right;
    uint32_t sampleRate = 0;
};

bool LoadStereoWavPlanar(const std::filesystem::path& wavPath, PlanarStereoAudio& outAudio, std::string& errMsg) {
    std::ifstream in(wavPath, std::ios::binary | std::ios::ate);
    if (!in.is_open()) {
        errMsg = "Failed to open input WAV file";
        return false;
    }
    const std::streamoff totalBytesOff = in.tellg();
    if (totalBytesOff < 44) {
        errMsg = "Input file is too small to be a valid WAV";
        return false;
    }
    in.seekg(0, std::ios::beg);

    uint8_t riffHdr[12]{};
    if (!in.read(reinterpret_cast<char*>(riffHdr), 12)) {
        errMsg = "Failed to read RIFF header";
        return false;
    }
    if (std::memcmp(riffHdr, "RIFF", 4) != 0 || std::memcmp(riffHdr + 8, "WAVE", 4) != 0) {
        errMsg = "Input is not a RIFF/WAVE file";
        return false;
    }

    bool hasFmt = false;
    bool hasData = false;
    uint16_t audioFormat = 0;
    uint16_t channels = 0;
    uint32_t sampleRate = 0;
    uint16_t bitsPerSample = 0;
    uint16_t extSubFormat = 0;
    std::vector<uint8_t> rawData;

    while (in.good()) {
        uint8_t chunkHdr[8]{};
        if (!in.read(reinterpret_cast<char*>(chunkHdr), 8)) break;
        const uint32_t chunkSize = ReadU32LE(chunkHdr + 4);
        const std::streamoff curPos = in.tellg();
        if (curPos < 0 || curPos + static_cast<std::streamoff>(chunkSize) > totalBytesOff) {
            errMsg = "Truncated WAV chunk";
            return false;
        }

        if (std::memcmp(chunkHdr, "fmt ", 4) == 0) {
            if (chunkSize < 16) {
                errMsg = "Invalid WAV fmt chunk";
                return false;
            }
            std::vector<uint8_t> fmtBuf(chunkSize);
            if (!in.read(reinterpret_cast<char*>(fmtBuf.data()), chunkSize)) {
                errMsg = "Failed reading fmt chunk";
                return false;
            }
            audioFormat = ReadU16LE(fmtBuf.data() + 0);
            channels = ReadU16LE(fmtBuf.data() + 2);
            sampleRate = ReadU32LE(fmtBuf.data() + 4);
            bitsPerSample = ReadU16LE(fmtBuf.data() + 14);
            if (audioFormat == 0xFFFE && chunkSize >= 40) {
                extSubFormat = ReadU16LE(fmtBuf.data() + 24);
            }
            hasFmt = true;
        } else if (std::memcmp(chunkHdr, "data", 4) == 0) {
            rawData.resize(chunkSize);
            if (chunkSize > 0 && !in.read(reinterpret_cast<char*>(rawData.data()), chunkSize)) {
                errMsg = "Failed reading WAV data chunk";
                return false;
            }
            hasData = true;
        } else {
            in.seekg(static_cast<std::streamoff>(chunkSize), std::ios::cur);
        }

        if (chunkSize & 1u) {
            in.seekg(1, std::ios::cur);
        }
        if (hasFmt && hasData) break;
    }

    if (!hasFmt || !hasData) {
        errMsg = "WAV missing fmt or data chunk";
        return false;
    }
    const uint16_t effectiveFmt = (audioFormat == 0xFFFE) ? extSubFormat : audioFormat;
    if (effectiveFmt != 1 && effectiveFmt != 3) {
        errMsg = "Unsupported WAV format (expected PCM or IEEE float)";
        return false;
    }
    if (channels < 1 || channels > 2) {
        errMsg = "Unsupported channel count (expected mono or stereo)";
        return false;
    }
    if (sampleRate != TARGET_SAMPLE_RATE) {
        errMsg = "Input WAV sample rate must be 44100 Hz";
        return false;
    }

    const size_t bytesPerSample = bitsPerSample / 8;
    if ((effectiveFmt == 1 && bitsPerSample != 16 && bitsPerSample != 24 && bitsPerSample != 32) ||
        (effectiveFmt == 3 && bitsPerSample != 32)) {
        errMsg = "Unsupported WAV bit depth";
        return false;
    }

    const size_t bytesPerFrame = bytesPerSample * channels;
    const size_t totalFrames = bytesPerFrame > 0 ? (rawData.size() / bytesPerFrame) : 0;
    if (totalFrames == 0) {
        errMsg = "Input WAV contains 0 audio frames";
        return false;
    }

    outAudio.sampleRate = sampleRate;
    outAudio.left.resize(totalFrames);
    outAudio.right.resize(totalFrames);

    const uint8_t* ptr = rawData.data();
    for (size_t i = 0; i < totalFrames; ++i) {
        float chSamples[2] = { 0.0f, 0.0f };
        for (size_t c = 0; c < channels; ++c) {
            const uint8_t* sp = ptr + i * bytesPerFrame + c * bytesPerSample;
            float val = 0.0f;
            if (effectiveFmt == 3 && bitsPerSample == 32) {
                std::memcpy(&val, sp, sizeof(float));
                if (!std::isfinite(val)) val = 0.0f;
            } else if (bitsPerSample == 16) {
                int16_t s = static_cast<int16_t>(ReadU16LE(sp));
                val = static_cast<float>(s) / 32768.0f;
            } else if (bitsPerSample == 24) {
                int32_t s = ReadS24LE(sp);
                val = static_cast<float>(s) / 8388608.0f;
            } else if (bitsPerSample == 32) {
                int32_t s = static_cast<int32_t>(ReadU32LE(sp));
                val = static_cast<float>(static_cast<double>(s) / 2147483648.0);
            }
            chSamples[c] = val;
        }
        outAudio.left[i] = chSamples[0];
        outAudio.right[i] = (channels == 2) ? chSamples[1] : chSamples[0];
    }
    return true;
}

bool WriteStereoWav16(const std::filesystem::path& outPath, const float* left, const float* right, size_t totalFrames, std::string& errMsg) {
    if (totalFrames > (std::numeric_limits<uint32_t>::max() - 36u) / 4u) {
        errMsg = "Audio length exceeds 4GB WAV RIFF limit";
        return false;
    }
    std::ofstream out(outPath, std::ios::binary | std::ios::trunc);
    if (!out.is_open()) {
        errMsg = "Failed to open output WAV for writing";
        return false;
    }

    const uint32_t dataBytes = static_cast<uint32_t>(totalFrames * 4u);
    const uint32_t riffSize = 36u + dataBytes;

    out.write("RIFF", 4);
    WriteU32LE(out, riffSize);
    out.write("WAVE", 4);
    out.write("fmt ", 4);
    WriteU32LE(out, 16u);
    WriteU16LE(out, 1u); // PCM
    WriteU16LE(out, 2u); // stereo
    WriteU32LE(out, TARGET_SAMPLE_RATE);
    WriteU32LE(out, TARGET_SAMPLE_RATE * 4u);
    WriteU16LE(out, 4u);
    WriteU16LE(out, 16u);
    out.write("data", 4);
    WriteU32LE(out, dataBytes);

    std::vector<int16_t> interleaved(totalFrames * 2u);
    for (size_t i = 0; i < totalFrames; ++i) {
        const float l = std::clamp(std::isfinite(left[i]) ? left[i] : 0.0f, -1.0f, 1.0f);
        const float r = std::clamp(std::isfinite(right[i]) ? right[i] : 0.0f, -1.0f, 1.0f);
        interleaved[i * 2u] = static_cast<int16_t>(std::lrintf(l * 32767.0f));
        interleaved[i * 2u + 1u] = static_cast<int16_t>(std::lrintf(r * 32767.0f));
    }
    out.write(reinterpret_cast<const char*>(interleaved.data()), static_cast<std::streamsize>(dataBytes));
    if (!out.good()) {
        errMsg = "Failed writing output WAV samples";
        return false;
    }
    return true;
}

std::vector<float> MakeOverlapWindow() {
    std::vector<float> w(SEGMENT_SAMPLES, 1.0f);
    for (size_t i = 0; i < OVERLAP_SAMPLES; ++i) {
        const float fade = static_cast<float>(i) / static_cast<float>(OVERLAP_SAMPLES - 1);
        w[i] = fade;
        w[SEGMENT_SAMPLES - 1 - i] = fade;
    }
    return w;
}

bool TryConfigureDml(Ort::SessionOptions& opts, std::string& reasonOut) {
    const OrtDmlApi* dmlApi = nullptr;
    OrtStatus* st = Ort::GetApi().GetExecutionProviderApi("DML", ORT_API_VERSION, reinterpret_cast<const void**>(&dmlApi));
    if (st != nullptr || dmlApi == nullptr) {
        if (st != nullptr) {
            reasonOut = Ort::GetApi().GetErrorMessage(st);
            Ort::GetApi().ReleaseStatus(st);
        } else {
            reasonOut = "DML EP API unavailable";
        }
        return false;
    }
    opts.DisableMemPattern();
    opts.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
    OrtDmlDeviceOptions devOpts{};
    devOpts.Preference = OrtDmlPerformancePreference::HighPerformance;
    devOpts.Filter = OrtDmlDeviceFilter::Gpu;
    st = dmlApi->SessionOptionsAppendExecutionProvider_DML2(opts, &devOpts);
    if (st != nullptr) {
        Ort::GetApi().ReleaseStatus(st);
        st = dmlApi->SessionOptionsAppendExecutionProvider_DML(opts, 0);
        if (st != nullptr) {
            reasonOut = Ort::GetApi().GetErrorMessage(st);
            Ort::GetApi().ReleaseStatus(st);
            return false;
        }
    }
    return true;
}

int ParsePositiveIntBounded(const wchar_t* text, int maxVal) {
    if (!text || *text == L'\0') return 0;
    long val = 0;
    for (const wchar_t* p = text; *p != L'\0'; ++p) {
        if (*p < L'0' || *p > L'9') return 0;
        val = val * 10L + (*p - L'0');
        if (val > maxVal) return maxVal;
    }
    return static_cast<int>(val);
}

/**
 * Cap CPU intra-op threads to ~25% of logical processors (bounded [2, 5] by default)
 * so long HTDemucs runs keep the Windows desktop and VANTA UI responsive.
 */
int ResolveBoundedCpuThreads(int requestedThreads) {
    const int hw = static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    if (requestedThreads > 0) {
        return std::clamp(requestedThreads, 1, std::min(16, hw));
    }
    if (hw <= 4) return std::max(1, hw / 2);
    return std::clamp(hw / 4, 2, 5);
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    // Keep heavy neural audio inference below normal desktop UI / DWM priority.
    static_cast<void>(SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS));

    std::wstring modelPathW;
    std::wstring inputPathW;
    std::wstring outDirW;
    std::string requestedProvider = "auto";
    int requestedThreads = 0;
    std::array<bool, NUM_STEMS> writeStem = { true, true, true, true };

    for (int i = 1; i < argc; ++i) {
        const std::wstring arg = argv[i];
        if (arg == L"--model" && i + 1 < argc) {
            modelPathW = argv[++i];
        } else if (arg == L"--input" && i + 1 < argc) {
            inputPathW = argv[++i];
        } else if (arg == L"--out-dir" && i + 1 < argc) {
            outDirW = argv[++i];
        } else if (arg == L"--provider" && i + 1 < argc) {
            requestedProvider = WideToUtf8(argv[++i]);
        } else if (arg == L"--threads" && i + 1 < argc) {
            requestedThreads = ParsePositiveIntBounded(argv[++i], 16);
        } else if (arg == L"--stems" && i + 1 < argc) {
            const std::string list = WideToUtf8(argv[++i]);
            writeStem = { false, false, false, false };
            for (size_t s = 0; s < NUM_STEMS; ++s) {
                if (list.find(STEM_NAMES[s]) != std::string::npos) {
                    writeStem[s] = true;
                }
            }
        }
    }

    if (modelPathW.empty() || inputPathW.empty() || outDirW.empty()) {
        EmitError("Usage: vanta-stem-engine.exe --model <onnx> --input <wav44k> --out-dir <dir> [--provider auto|dml|cpu] [--threads <1..16>] [--stems drums,bass,other,vocals]");
        return 2;
    }

    std::error_code ec;
    const std::filesystem::path modelPath(modelPathW);
    const std::filesystem::path inputPath(inputPathW);
    const std::filesystem::path outDir(outDirW);

    if (!std::filesystem::exists(modelPath, ec) || !std::filesystem::is_regular_file(modelPath, ec)) {
        EmitError("HTDemucs ONNX model file not found");
        return 3;
    }
    std::filesystem::create_directories(outDir, ec);
    if (ec) {
        EmitError("Failed to create stem output directory");
        return 4;
    }

    PlanarStereoAudio mix;
    std::string ioErr;
    if (!LoadStereoWavPlanar(inputPath, mix, ioErr)) {
        EmitError(ioErr);
        return 5;
    }

    const auto tStart = std::chrono::steady_clock::now();
    const size_t totalSamples = mix.left.size();
    const size_t numChunks = std::max<size_t>(1, (totalSamples + STRIDE_SAMPLES - 1) / STRIDE_SAMPLES);

    try {
        Ort::Env env(ORT_LOGGING_LEVEL_ERROR, "VantaStemEngine");
        std::unique_ptr<Ort::Session> session;
        std::string activeProvider = "cpu";
        std::string dmlNote;

        if (requestedProvider == "dml-experimental") {
            try {
                Ort::SessionOptions dmlOpts;
                dmlOpts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_BASIC);
                if (TryConfigureDml(dmlOpts, dmlNote)) {
                    session = std::make_unique<Ort::Session>(env, modelPath.c_str(), dmlOpts);
                    activeProvider = "dml";
                }
            } catch (const Ort::Exception& ex) {
                dmlNote = ex.what();
                session.reset();
            }
        }

        if (!session) {
            if (requestedProvider == "dml-experimental" && !dmlNote.empty()) {
                EmitJsonLine("{\"type\":\"warn\",\"message\":\"DirectML unavailable, falling back to CPU: " + EscapeJson(dmlNote) + "\"}");
            }
            const int cpuThreads = ResolveBoundedCpuThreads(requestedThreads);
            Ort::SessionOptions cpuOpts;
            cpuOpts.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
            // HTDemucs FP16 graph optimization triggers a >4.5 GB ConstantFolding peak on CPU EP.
            cpuOpts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_DISABLE_ALL);
            cpuOpts.SetIntraOpNumThreads(cpuThreads);
            cpuOpts.SetInterOpNumThreads(1);
            cpuOpts.AddConfigEntry("session.intra_op.allow_spinning", "0");
            cpuOpts.AddConfigEntry("session.inter_op.allow_spinning", "0");
            cpuOpts.AddConfigEntry("session.force_spinning_stop", "1");
            cpuOpts.AddConfigEntry("session.use_device_allocator_for_initializers", "1");
            session = std::make_unique<Ort::Session>(env, modelPath.c_str(), cpuOpts);
            activeProvider = "cpu";
        }

        const double durationSec = static_cast<double>(totalSamples) / static_cast<double>(TARGET_SAMPLE_RATE);
        char initBuf[512];
        std::snprintf(
            initBuf,
            sizeof(initBuf),
            "{\"type\":\"init\",\"provider\":\"%s\",\"chunks\":%zu,\"duration_s\":%.3f}",
            activeProvider.c_str(),
            numChunks,
            durationSec
        );
        EmitJsonLine(initBuf);

        Ort::RunOptions runOpts;
        if (activeProvider == "cpu") {
            runOpts.AddConfigEntry("memory.enable_memory_arena_shrinkage", "cpu:0");
        }
        Ort::MemoryInfo memInfo = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeDefault);
        const std::array<int64_t, 3> inputShape = { 1, static_cast<int64_t>(TARGET_CHANNELS), static_cast<int64_t>(SEGMENT_SAMPLES) };
        const std::array<const char*, 1> inputNames = { "mix" };
        const std::array<const char*, 1> outputNames = { "stems" };

        std::vector<float> chunkInput(TARGET_CHANNELS * SEGMENT_SAMPLES, 0.0f);
        const std::vector<float> window = MakeOverlapWindow();

        std::array<std::vector<float>, NUM_STEMS * TARGET_CHANNELS> accum;
        for (size_t s = 0; s < NUM_STEMS; ++s) {
            if (!writeStem[s]) continue;
            accum[s * TARGET_CHANNELS + 0].assign(totalSamples, 0.0f);
            accum[s * TARGET_CHANNELS + 1].assign(totalSamples, 0.0f);
        }
        std::vector<float> weight(totalSamples, 0.0f);

        for (size_t c = 0; c < numChunks; ++c) {
            const size_t start = c * STRIDE_SAMPLES;
            const size_t end = std::min(start + SEGMENT_SAMPLES, totalSamples);
            const size_t copyLen = end - start;

            std::fill(chunkInput.begin(), chunkInput.end(), 0.0f);
            std::memcpy(chunkInput.data(), mix.left.data() + start, copyLen * sizeof(float));
            std::memcpy(chunkInput.data() + SEGMENT_SAMPLES, mix.right.data() + start, copyLen * sizeof(float));

            Ort::Value inTensor = Ort::Value::CreateTensor<float>(
                memInfo,
                chunkInput.data(),
                chunkInput.size(),
                inputShape.data(),
                inputShape.size()
            );

            auto outputs = session->Run(
                runOpts,
                inputNames.data(),
                &inTensor,
                1,
                outputNames.data(),
                1
            );

            if (outputs.empty() || !outputs[0].IsTensor()) {
                EmitError("Model returned invalid stems tensor");
                return 6;
            }

            const auto typeInfo = outputs[0].GetTensorTypeAndShapeInfo();
            const auto outShape = typeInfo.GetShape();
            if (outShape.size() != 4 || outShape[1] != static_cast<int64_t>(NUM_STEMS) ||
                outShape[2] != static_cast<int64_t>(TARGET_CHANNELS) || outShape[3] != static_cast<int64_t>(SEGMENT_SAMPLES)) {
                EmitError("Unexpected HTDemucs output tensor shape");
                return 7;
            }

            const float* stemsData = outputs[0].GetTensorData<float>();
            for (size_t s = 0; s < NUM_STEMS; ++s) {
                if (!writeStem[s]) continue;
                for (size_t ch = 0; ch < TARGET_CHANNELS; ++ch) {
                    const float* srcPtr = stemsData + (s * TARGET_CHANNELS + ch) * SEGMENT_SAMPLES;
                    float* dstPtr = accum[s * TARGET_CHANNELS + ch].data() + start;
                    for (size_t k = 0; k < copyLen; ++k) {
                        dstPtr[k] += srcPtr[k] * window[k];
                    }
                }
            }
            for (size_t k = 0; k < copyLen; ++k) {
                weight[start + k] += window[k];
            }

            const int pct = static_cast<int>(((c + 1) * 100) / numChunks);
            char progBuf[160];
            std::snprintf(progBuf, sizeof(progBuf), "{\"type\":\"progress\",\"chunk\":%zu,\"total\":%zu,\"pct\":%d}", c + 1, numChunks, pct);
            EmitJsonLine(progBuf);
        }

        // Release input mix buffers before normalizing and writing output stems.
        std::vector<float>().swap(mix.left);
        std::vector<float>().swap(mix.right);

        for (size_t i = 0; i < totalSamples; ++i) {
            const float inv = 1.0f / std::max(weight[i], 1e-8f);
            for (size_t s = 0; s < NUM_STEMS; ++s) {
                if (!writeStem[s]) continue;
                accum[s * TARGET_CHANNELS + 0][i] *= inv;
                accum[s * TARGET_CHANNELS + 1][i] *= inv;
            }
        }
        std::vector<float>().swap(weight);

        std::string stemsJson = "{";
        bool firstStem = true;
        for (size_t s = 0; s < NUM_STEMS; ++s) {
            if (!writeStem[s]) continue;
            const std::filesystem::path stemOut = outDir / (std::string(STEM_NAMES[s]) + ".wav");
            if (!WriteStereoWav16(stemOut, accum[s * TARGET_CHANNELS + 0].data(), accum[s * TARGET_CHANNELS + 1].data(), totalSamples, ioErr)) {
                EmitError(ioErr);
                return 8;
            }
            std::vector<float>().swap(accum[s * TARGET_CHANNELS + 0]);
            std::vector<float>().swap(accum[s * TARGET_CHANNELS + 1]);
            if (!firstStem) stemsJson += ",";
            firstStem = false;
            stemsJson += "\"" + std::string(STEM_NAMES[s]) + "\":\"" + EscapeJson(WideToUtf8(stemOut.wstring())) + "\"";
        }
        stemsJson += "}";

        const auto elapsedMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - tStart).count();
        EmitJsonLine(
            "{\"type\":\"done\",\"provider\":\"" + activeProvider +
            "\",\"elapsed_ms\":" + std::to_string(elapsedMs) +
            ",\"stems\":" + stemsJson + "}"
        );
        return 0;
    } catch (const Ort::Exception& ex) {
        EmitError(std::string("ONNX Runtime error: ") + ex.what());
        return 9;
    } catch (const std::exception& ex) {
        EmitError(std::string("Native exception: ") + ex.what());
        return 10;
    }
}
