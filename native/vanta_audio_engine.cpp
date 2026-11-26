// VANTA Native Windows WASAPI Exclusive & Shared Audio Engine
// Targets Windows 10/11 Official Microsoft Core Audio (MMDevice / IAudioClient / IAudioRenderClient)
// Build (MSVC x64): cl.exe /EHsc /O2 /W4 /WX /DUNICODE /D_UNICODE vanta_audio_engine.cpp ole32.lib avrt.lib /Fe:..\bin\vanta-audio-engine.exe

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <endpointvolume.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <ks.h>
#include <ksmedia.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <io.h>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <type_traits>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

#include "vanta_asio_backend.hpp"
#include "vanta_sacd_iso.hpp"
#include "vanta_convolver.hpp"

namespace {

constexpr size_t RING_FRAMES = 131072; // ~0.68s @ 192kHz, ~2.97s @ 44.1kHz stereo s32
constexpr uint32_t DEFAULT_CHANNELS = 2;

std::mutex g_stdoutMutex;

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

std::string WideToUtf8(const wchar_t* wstr) {
    if (!wstr || !*wstr) return "";
    int needed = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, nullptr, 0, nullptr, nullptr);
    if (needed <= 1) return "";
    std::string out(static_cast<size_t>(needed - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wstr, -1, out.data(), needed, nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(const std::string& str) {
    if (str.empty()) return L"";
    int needed = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, nullptr, 0);
    if (needed <= 1) return L"";
    std::wstring out(static_cast<size_t>(needed - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, out.data(), needed);
    return out;
}

void EmitJsonLine(const std::string& json) {
    std::lock_guard<std::mutex> lock(g_stdoutMutex);
    std::fwrite(json.data(), 1, json.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

std::string FormatHResult(HRESULT hr) {
    char buf[24];
    std::snprintf(buf, sizeof(buf), "0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

struct AudioDeviceInfo {
    std::string id;
    std::string name;
    bool isDefault = false;
};

std::string ReadDeviceFriendlyName(IMMDevice* pDevice) {
    IPropertyStore* pProps = nullptr;
    std::string name = "Windows Audio Device";
    if (SUCCEEDED(pDevice->OpenPropertyStore(STGM_READ, &pProps)) && pProps) {
        PROPVARIANT varName;
        PropVariantInit(&varName);
        if (SUCCEEDED(pProps->GetValue(PKEY_Device_FriendlyName, &varName))) {
            if (varName.vt == VT_LPWSTR && varName.pwszVal) {
                name = WideToUtf8(varName.pwszVal);
            }
            PropVariantClear(&varName);
        }
        pProps->Release();
    }
    return name;
}

int ListAudioDevices() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        std::fprintf(stderr, "CoInitializeEx failed: %s\n", FormatHResult(hr).c_str());
        return 1;
    }

    IMMDeviceEnumerator* pEnum = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&pEnum));
    if (FAILED(hr) || !pEnum) {
        CoUninitialize();
        return 2;
    }

    std::wstring defaultId;
    IMMDevice* pDefault = nullptr;
    if (SUCCEEDED(pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDefault)) && pDefault) {
        LPWSTR pId = nullptr;
        if (SUCCEEDED(pDefault->GetId(&pId)) && pId) {
            defaultId = pId;
            CoTaskMemFree(pId);
        }
        pDefault->Release();
    }

    std::vector<AudioDeviceInfo> devices;
    IMMDeviceCollection* pCollection = nullptr;
    if (SUCCEEDED(pEnum->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &pCollection)) && pCollection) {
        UINT count = 0;
        pCollection->GetCount(&count);
        for (UINT i = 0; i < count; ++i) {
            IMMDevice* pDev = nullptr;
            if (SUCCEEDED(pCollection->Item(i, &pDev)) && pDev) {
                AudioDeviceInfo info;
                LPWSTR pId = nullptr;
                if (SUCCEEDED(pDev->GetId(&pId)) && pId) {
                    info.id = WideToUtf8(pId);
                    info.isDefault = (!defaultId.empty() && defaultId == pId);
                    CoTaskMemFree(pId);
                }
                info.name = ReadDeviceFriendlyName(pDev);
                devices.push_back(info);
                pDev->Release();
            }
        }
        pCollection->Release();
    }

    pEnum->Release();
    CoUninitialize();

    std::string json = "[";
    for (size_t i = 0; i < devices.size(); ++i) {
        if (i > 0) json += ",";
        json += "{\"id\":\"" + EscapeJson(devices[i].id) +
                "\",\"name\":\"" + EscapeJson(devices[i].name) +
                "\",\"isDefault\":" + (devices[i].isDefault ? "true" : "false") + "}";
    }
    json += "]";
    EmitJsonLine(json);
    return 0;
}

template <typename SampleT>
class FrameRingBuffer {
public:
    explicit FrameRingBuffer(size_t capacityFrames, uint32_t channels)
        : m_capacity(capacityFrames > 0 ? capacityFrames : 1024),
          m_channels(channels > 0 ? channels : 2),
          m_data(m_capacity * m_channels, SampleT{}) {}

    void Reconfigure(size_t capacityFrames, uint32_t channels) {
        m_writePos.store(0);
        m_readPos.store(0);
        m_capacity = capacityFrames > 0 ? capacityFrames : 1024;
        m_channels = channels > 0 ? channels : 2;
        m_data.assign(m_capacity * m_channels, SampleT{});
    }

    size_t AvailableToRead() const {
        const size_t w = m_writePos.load(std::memory_order_acquire);
        const size_t r = m_readPos.load(std::memory_order_acquire);
        return w - r;
    }

    size_t AvailableToWrite() const {
        return m_capacity - AvailableToRead();
    }

    size_t Write(const SampleT* src, size_t frames) {
        const size_t avail = AvailableToWrite();
        const size_t toWrite = (frames < avail) ? frames : avail;
        if (toWrite == 0) return 0;

        const size_t w = m_writePos.load(std::memory_order_relaxed);
        for (size_t i = 0; i < toWrite; ++i) {
            const size_t idx = ((w + i) % m_capacity) * m_channels;
            for (uint32_t ch = 0; ch < m_channels; ++ch) {
                m_data[idx + ch] = src[i * m_channels + ch];
            }
        }
        m_writePos.store(w + toWrite, std::memory_order_release);
        return toWrite;
    }

    size_t Read(SampleT* dst, size_t frames) {
        const size_t avail = AvailableToRead();
        const size_t toRead = (frames < avail) ? frames : avail;
        if (toRead == 0) return 0;

        const size_t r = m_readPos.load(std::memory_order_relaxed);
        for (size_t i = 0; i < toRead; ++i) {
            const size_t idx = ((r + i) % m_capacity) * m_channels;
            for (uint32_t ch = 0; ch < m_channels; ++ch) {
                dst[i * m_channels + ch] = m_data[idx + ch];
            }
        }
        m_readPos.store(r + toRead, std::memory_order_release);
        return toRead;
    }

private:
    size_t m_capacity;
    uint32_t m_channels;
    std::vector<SampleT> m_data;
    std::atomic<size_t> m_writePos{0};
    std::atomic<size_t> m_readPos{0};
};

using PcmRingBuffer = FrameRingBuffer<int32_t>;

enum class InputWireFormat {
    S32LE,
    F32LE,
    F64LE
};

InputWireFormat ParseInputWireFormat(const std::string& name) {
    if (name == "f64le") return InputWireFormat::F64LE;
    if (name == "f32le") return InputWireFormat::F32LE;
    return InputWireFormat::S32LE;
}

std::string InputWireFormatName(InputWireFormat fmt) {
    switch (fmt) {
        case InputWireFormat::F64LE: return "f64le";
        case InputWireFormat::F32LE: return "f32le";
        case InputWireFormat::S32LE: return "s32le";
    }
    return "s32le";
}

enum class WireSampleFormat {
    Pcm16,
    Pcm24Packed,
    Pcm24In32,
    Pcm32,
    Float32
};

DWORD ChannelMaskForCount(uint16_t channels) {
    switch (channels) {
        case 1: return SPEAKER_FRONT_CENTER;
        case 2: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
        case 3: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_LOW_FREQUENCY;
        case 4: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
        case 5: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
        case 6: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT;
        case 7: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_CENTER | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT;
        case 8: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT;
        default: return SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT;
    }
}

WAVEFORMATEXTENSIBLE BuildFormat(uint32_t sampleRate, uint16_t channels, uint16_t containerBits, uint16_t validBits, bool isFloat) {
    WAVEFORMATEXTENSIBLE wf{};
    wf.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wf.Format.nChannels = channels;
    wf.Format.nSamplesPerSec = sampleRate;
    wf.Format.wBitsPerSample = containerBits;
    wf.Format.nBlockAlign = static_cast<WORD>((channels * containerBits) / 8);
    wf.Format.nAvgBytesPerSec = sampleRate * wf.Format.nBlockAlign;
    wf.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    wf.Samples.wValidBitsPerSample = validBits;
    wf.dwChannelMask = ChannelMaskForCount(channels);
    wf.SubFormat = isFloat ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
    return wf;
}

struct TelemetryFrameStats {
    float lPeak = 0.0f;
    float rPeak = 0.0f;
    double lSumSq = 0.0;
    double rSumSq = 0.0;
    uint32_t frameCount = 0;
};

constexpr size_t MAX_AUDIO_CHANNELS = 8;

inline double ClampDouble(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

struct AudioAnalysisMeters64 {
    double tpHist[MAX_AUDIO_CHANNELS][4] = {};
    double windowTruePeakLin = 0.0;
    uint32_t srcOrMask = 0;
    uint32_t wireOrMask = 0;
    uint32_t lastStableSrcBits = 0;
    uint32_t lastStableWireBits = 0;
    uint64_t bitWindowFrames = 0;

    static constexpr size_t kDrBuckets = 20;
    double secPeak[kDrBuckets] = {};
    double secRms[kDrBuckets] = {};
    size_t secIdx = 0;
    size_t secFilled = 0;
    double curSecSumSq = 0.0;
    double curSecPeak = 0.0;
    uint64_t curSecFrames = 0;

    void ResetForTrack() {
        std::memset(tpHist, 0, sizeof(tpHist));
        windowTruePeakLin = 0.0;
        srcOrMask = 0;
        wireOrMask = 0;
        lastStableSrcBits = 0;
        lastStableWireBits = 0;
        bitWindowFrames = 0;
        std::memset(secPeak, 0, sizeof(secPeak));
        std::memset(secRms, 0, sizeof(secRms));
        secIdx = 0;
        secFilled = 0;
        curSecSumSq = 0.0;
        curSecPeak = 0.0;
        curSecFrames = 0;
    }

    static inline uint32_t CountActiveBitsFromMask(uint32_t orMask) {
        if (orMask == 0u) return 0u;
        uint32_t tz = 0u;
        while (tz < 32u && ((orMask >> tz) & 1u) == 0u) {
            ++tz;
        }
        return 32u - tz;
    }

    static inline double EvalHermite(double ym1, double y0, double y1, double y2, double frac) {
        const double c0 = y0;
        const double c1 = 0.5 * (y1 - ym1);
        const double c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
        const double c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
        return ((c3 * frac + c2) * frac + c1) * frac + c0;
    }

    inline void PushOutputSample(double normalized, uint32_t ch, uint32_t srcWord32, uint32_t wireWord32) {
        srcOrMask |= srcWord32;
        wireOrMask |= wireWord32;
        const double absCur = std::fabs(normalized);
        if (absCur > windowTruePeakLin) windowTruePeakLin = absCur;
        if (absCur > curSecPeak) curSecPeak = absCur;
        if (ch < MAX_AUDIO_CHANNELS) {
            tpHist[ch][0] = tpHist[ch][1];
            tpHist[ch][1] = tpHist[ch][2];
            tpHist[ch][2] = tpHist[ch][3];
            tpHist[ch][3] = normalized;
            const double p1 = std::fabs(EvalHermite(tpHist[ch][0], tpHist[ch][1], tpHist[ch][2], tpHist[ch][3], 0.25));
            const double p2 = std::fabs(EvalHermite(tpHist[ch][0], tpHist[ch][1], tpHist[ch][2], tpHist[ch][3], 0.50));
            const double p3 = std::fabs(EvalHermite(tpHist[ch][0], tpHist[ch][1], tpHist[ch][2], tpHist[ch][3], 0.75));
            if (p1 > windowTruePeakLin) windowTruePeakLin = p1;
            if (p2 > windowTruePeakLin) windowTruePeakLin = p2;
            if (p3 > windowTruePeakLin) windowTruePeakLin = p3;
        }
        curSecSumSq += normalized * normalized;
    }

    void AdvanceFrame(uint32_t channels, uint32_t sampleRate) {
        const uint32_t sr = sampleRate > 0 ? sampleRate : 48000u;
        ++bitWindowFrames;
        if (bitWindowFrames >= sr) {
            if (srcOrMask != 0u) lastStableSrcBits = CountActiveBitsFromMask(srcOrMask);
            if (wireOrMask != 0u) lastStableWireBits = CountActiveBitsFromMask(wireOrMask);
            srcOrMask = 0u;
            wireOrMask = 0u;
            bitWindowFrames = 0u;
        }
        ++curSecFrames;
        if (curSecFrames >= sr) {
            const uint32_t chDiv = channels > 0 ? channels : 1u;
            const double rms = std::sqrt(curSecSumSq / static_cast<double>(curSecFrames * chDiv));
            secPeak[secIdx] = curSecPeak;
            secRms[secIdx] = rms;
            secIdx = (secIdx + 1) % kDrBuckets;
            if (secFilled < kDrBuckets) ++secFilled;
            curSecSumSq = 0.0;
            curSecPeak = 0.0;
            curSecFrames = 0;
        }
    }

    double ReadWindowTruePeakDbtpAndReset() {
        const double lin = windowTruePeakLin;
        windowTruePeakLin = 0.0;
        if (lin <= 1e-6) return -120.0;
        return 20.0 * std::log10(lin);
    }

    uint32_t CurrentSrcActiveBits() const {
        const uint32_t cur = CountActiveBitsFromMask(srcOrMask);
        return cur > 0u ? std::max(cur, lastStableSrcBits) : lastStableSrcBits;
    }

    uint32_t CurrentWireActiveBits() const {
        const uint32_t cur = CountActiveBitsFromMask(wireOrMask);
        return cur > 0u ? std::max(cur, lastStableWireBits) : lastStableWireBits;
    }

    double ComputeSessionDrDb(double fallbackCrestDb) const {
        if (secFilled == 0) return fallbackCrestDb;
        double sumDr = 0.0;
        size_t validCount = 0;
        for (size_t i = 0; i < secFilled; ++i) {
            if (secRms[i] > 1e-6 && secPeak[i] > 1e-6) {
                sumDr += 20.0 * std::log10(secPeak[i] / secRms[i]);
                ++validCount;
            }
        }
        if (validCount == 0) return fallbackCrestDb;
        return ClampDouble(sumDr / static_cast<double>(validCount), 0.0, 40.0);
    }
};

constexpr size_t FFT_N = 1024;
constexpr double VANTA_PI = 3.14159265358979323846;

void ComputeLogFft24(
    const float* monoRing,
    size_t writePos,
    uint32_t sampleRate,
    float* outBars,
    float* outWave32) {
    float re[FFT_N] = {};
    float im[FFT_N] = {};

    // Read newest 1024 mono samples with Hann window, and sample 32 clean wave points
    for (size_t i = 0; i < FFT_N; ++i) {
        const size_t idx = (writePos + i) % FFT_N;
        const float s = monoRing[idx];
        if ((i % 32) == 0 && (i / 32) < 32) {
            outWave32[i / 32] = s;
        }
        const float w = 0.5f * (1.0f - std::cos(static_cast<float>(2.0 * VANTA_PI * i / (FFT_N - 1))));
        re[i] = s * w;
        im[i] = 0.0f;
    }

    // Bit-reversal permutation
    for (size_t i = 1, j = 0; i < FFT_N; ++i) {
        size_t bit = FFT_N >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }

    // Iterative Radix-2 Cooley-Tukey FFT
    for (size_t len = 2; len <= FFT_N; len <<= 1) {
        const double ang = -2.0 * VANTA_PI / static_cast<double>(len);
        const float wlenRe = static_cast<float>(std::cos(ang));
        const float wlenIm = static_cast<float>(std::sin(ang));
        for (size_t i = 0; i < FFT_N; i += len) {
            float wRe = 1.0f;
            float wIm = 0.0f;
            const size_t half = len >> 1;
            for (size_t j = 0; j < half; ++j) {
                const size_t u = i + j;
                const size_t v = u + half;
                const float tRe = re[v] * wRe - im[v] * wIm;
                const float tIm = re[v] * wIm + im[v] * wRe;
                re[v] = re[u] - tRe;
                im[v] = im[u] - tIm;
                re[u] += tRe;
                im[u] += tIm;
                const float nextWRe = wRe * wlenRe - wIm * wlenIm;
                wIm = wRe * wlenIm + wIm * wlenRe;
                wRe = nextWRe;
            }
        }
    }

    // Logarithmic perceptual mapping across 24 bands (40 Hz -> min(18 kHz, Nyquist*0.92))
    const float sr = static_cast<float>(sampleRate > 0 ? sampleRate : 48000);
    const float minHz = 40.0f;
    const float maxHz = std::min(18000.0f, sr * 0.46f);
    const size_t nyquistBin = (FFT_N / 2) - 1;
    const float binHz = sr / static_cast<float>(FFT_N);

    for (int b = 0; b < 24; ++b) {
        const float t0 = static_cast<float>(b) / 24.0f;
        const float t1 = static_cast<float>(b + 1) / 24.0f;
        const float f0 = minHz * std::pow(maxHz / minHz, t0);
        const float f1 = minHz * std::pow(maxHz / minHz, t1);
        size_t b0 = static_cast<size_t>(std::floor(f0 / binHz));
        size_t b1 = static_cast<size_t>(std::ceil(f1 / binHz));
        if (b0 < 1) b0 = 1;
        if (b1 < b0) b1 = b0;
        if (b1 > nyquistBin) b1 = nyquistBin;

        float maxMag = 0.0f;
        for (size_t k = b0; k <= b1; ++k) {
            const float mag = std::sqrt(re[k] * re[k] + im[k] * im[k]) / (FFT_N * 0.25f);
            if (mag > maxMag) maxMag = mag;
        }
        // Perceptual tilt compensation so sub-bass & crisp highs remain balanced across genres
        const float tilt = 1.0f + 1.15f * t0;
        const float db = 20.0f * std::log10(std::max(1e-5f, maxMag * tilt));
        const float norm = (db + 66.0f) / 62.0f; // [-66dB, -4dB] -> [0, 1]
        outBars[b] = std::min(1.0f, std::max(0.05f, norm));
    }
}

constexpr double PUREPATH_EQ_FREQS[10] = {
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0
};

enum class BiquadType {
    LowPass,
    HighPass,
    LowShelf,
    HighShelf,
    PeakingEq,
    Notch,
    AllPass
};

constexpr size_t MAX_PEQ_BANDS = 32;

struct Biquad64 {
    bool bypass = true;
    double b0 = 1.0, b1 = 0.0, b2 = 0.0;
    double a1 = 0.0, a2 = 0.0;
    double z1[MAX_AUDIO_CHANNELS] = {};
    double z2[MAX_AUDIO_CHANNELS] = {};

    void ResetState() {
        for (size_t ch = 0; ch < MAX_AUDIO_CHANNELS; ++ch) {
            z1[ch] = 0.0;
            z2[ch] = 0.0;
        }
    }

    void Configure(BiquadType type, uint32_t sampleRate, double freqHz, double qVal, double gainDb) {
        if (!std::isfinite(freqHz) || !std::isfinite(qVal) || !std::isfinite(gainDb)) {
            bypass = true;
            b0 = 1.0; b1 = 0.0; b2 = 0.0; a1 = 0.0; a2 = 0.0;
            return;
        }
        if ((type == BiquadType::LowShelf || type == BiquadType::HighShelf || type == BiquadType::PeakingEq) &&
            std::fabs(gainDb) < 0.01) {
            bypass = true;
            b0 = 1.0; b1 = 0.0; b2 = 0.0; a1 = 0.0; a2 = 0.0;
            return;
        }
        const double sr = static_cast<double>(sampleRate >= 8000 ? sampleRate : 48000);
        const double fc = ClampDouble(freqHz, 10.0, sr * 0.49);
        const double q = ClampDouble(qVal, 0.05, 30.0);
        const double gDb = ClampDouble(gainDb, -30.0, 30.0);
        const double w0 = 2.0 * VANTA_PI * fc / sr;
        const double cosW0 = std::cos(w0);
        const double sinW0 = std::sin(w0);
        const double A = std::pow(10.0, gDb / 40.0);

        double a0 = 1.0;
        double nb0 = 1.0, nb1 = 0.0, nb2 = 0.0, na1 = 0.0, na2 = 0.0;

        switch (type) {
            case BiquadType::LowPass: {
                const double alpha = sinW0 / (2.0 * q);
                nb0 = (1.0 - cosW0) * 0.5;
                nb1 = 1.0 - cosW0;
                nb2 = (1.0 - cosW0) * 0.5;
                a0 = 1.0 + alpha;
                na1 = -2.0 * cosW0;
                na2 = 1.0 - alpha;
                break;
            }
            case BiquadType::HighPass: {
                const double alpha = sinW0 / (2.0 * q);
                nb0 = (1.0 + cosW0) * 0.5;
                nb1 = -(1.0 + cosW0);
                nb2 = (1.0 + cosW0) * 0.5;
                a0 = 1.0 + alpha;
                na1 = -2.0 * cosW0;
                na2 = 1.0 - alpha;
                break;
            }
            case BiquadType::Notch: {
                const double alpha = sinW0 / (2.0 * q);
                nb0 = 1.0;
                nb1 = -2.0 * cosW0;
                nb2 = 1.0;
                a0 = 1.0 + alpha;
                na1 = -2.0 * cosW0;
                na2 = 1.0 - alpha;
                break;
            }
            case BiquadType::AllPass: {
                const double alpha = sinW0 / (2.0 * q);
                nb0 = 1.0 - alpha;
                nb1 = -2.0 * cosW0;
                nb2 = 1.0 + alpha;
                a0 = 1.0 + alpha;
                na1 = -2.0 * cosW0;
                na2 = 1.0 - alpha;
                break;
            }
            case BiquadType::PeakingEq: {
                const double alpha = sinW0 / (2.0 * q);
                nb0 = 1.0 + alpha * A;
                nb1 = -2.0 * cosW0;
                nb2 = 1.0 - alpha * A;
                a0 = 1.0 + alpha / A;
                na1 = -2.0 * cosW0;
                na2 = 1.0 - alpha / A;
                break;
            }
            case BiquadType::LowShelf: {
                const double sqrtA = std::sqrt(A);
                const double alpha = (sinW0 * 0.5) * std::sqrt(std::max(0.0, (A + 1.0 / A) * (1.0 / q - 1.0) + 2.0));
                const double twoSqrtAAlpha = 2.0 * sqrtA * alpha;
                nb0 = A * ((A + 1.0) - (A - 1.0) * cosW0 + twoSqrtAAlpha);
                nb1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cosW0);
                nb2 = A * ((A + 1.0) - (A - 1.0) * cosW0 - twoSqrtAAlpha);
                a0 = (A + 1.0) + (A - 1.0) * cosW0 + twoSqrtAAlpha;
                na1 = -2.0 * ((A - 1.0) + (A + 1.0) * cosW0);
                na2 = (A + 1.0) + (A - 1.0) * cosW0 - twoSqrtAAlpha;
                break;
            }
            case BiquadType::HighShelf: {
                const double sqrtA = std::sqrt(A);
                const double alpha = (sinW0 * 0.5) * std::sqrt(std::max(0.0, (A + 1.0 / A) * (1.0 / q - 1.0) + 2.0));
                const double twoSqrtAAlpha = 2.0 * sqrtA * alpha;
                nb0 = A * ((A + 1.0) + (A - 1.0) * cosW0 + twoSqrtAAlpha);
                nb1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cosW0);
                nb2 = A * ((A + 1.0) + (A - 1.0) * cosW0 - twoSqrtAAlpha);
                a0 = (A + 1.0) - (A - 1.0) * cosW0 + twoSqrtAAlpha;
                na1 = 2.0 * ((A - 1.0) - (A + 1.0) * cosW0);
                na2 = (A + 1.0) - (A - 1.0) * cosW0 - twoSqrtAAlpha;
                break;
            }
        }

        if (!std::isfinite(a0) || std::fabs(a0) < 1e-18) {
            bypass = true;
            b0 = 1.0; b1 = 0.0; b2 = 0.0; a1 = 0.0; a2 = 0.0;
            return;
        }
        b0 = nb0 / a0;
        b1 = nb1 / a0;
        b2 = nb2 / a0;
        a1 = na1 / a0;
        a2 = na2 / a0;
        if (!std::isfinite(b0) || !std::isfinite(b1) || !std::isfinite(b2) || !std::isfinite(a1) || !std::isfinite(a2)) {
            bypass = true;
            b0 = 1.0; b1 = 0.0; b2 = 0.0; a1 = 0.0; a2 = 0.0;
            return;
        }
        bypass = false;
    }

    inline double ProcessSample(double x, uint32_t ch) {
        if (bypass || ch >= MAX_AUDIO_CHANNELS) return x;
        const double y = b0 * x + z1[ch];
        z1[ch] = b1 * x - a1 * y + z2[ch];
        z2[ch] = b2 * x - a2 * y;
        return y;
    }
};

struct PeqBandSpec {
    BiquadType type = BiquadType::PeakingEq;
    double freqHz = 1000.0;
    double q = 0.70710678;
    double gainDb = 0.0;
};

struct PeqConfigSnapshot {
    bool enabled = false;
    double preampDb = 0.0;
    size_t bandCount = 0;
    PeqBandSpec bands[MAX_PEQ_BANDS] = {};

    bool HasActive() const {
        return enabled && (bandCount > 0 || std::fabs(preampDb) >= 0.01);
    }
};

struct DspConfigSnapshot {
    double bandGains[10] = {};
    bool bass = false;
    double bassDb = 5.5;
    bool crossfeed = false;
    double crossfeedPct = 55.0;
    bool limiter = false;
    PeqConfigSnapshot peq;

    bool Has10BandActive() const {
        for (int i = 0; i < 10; ++i) {
            if (std::fabs(bandGains[i]) >= 0.01) return true;
        }
        return false;
    }

    bool HasEqActive() const {
        return Has10BandActive() || peq.HasActive();
    }

    bool HasEqOrTone() const {
        return HasEqActive() || bass || crossfeed;
    }

    bool NeedsHeadroomProtection() const {
        if (bass && bassDb > 0.25) return true;
        for (int i = 0; i < 10; ++i) {
            if (bandGains[i] > 0.25) return true;
        }
        if (peq.HasActive()) {
            if (peq.preampDb > 0.25) return true;
            for (size_t i = 0; i < peq.bandCount && i < MAX_PEQ_BANDS; ++i) {
                if ((peq.bands[i].gainDb + peq.preampDb) > 0.25) return true;
            }
        }
        return false;
    }
};

inline bool ParsePeqTypeToken(const std::string& tok, BiquadType& outType) {
    if (tok == "PK") { outType = BiquadType::PeakingEq; return true; }
    if (tok == "LSC" || tok == "LS") { outType = BiquadType::LowShelf; return true; }
    if (tok == "HSC" || tok == "HS") { outType = BiquadType::HighShelf; return true; }
    if (tok == "LPQ" || tok == "LP") { outType = BiquadType::LowPass; return true; }
    if (tok == "HPQ" || tok == "HP") { outType = BiquadType::HighPass; return true; }
    if (tok == "NO") { outType = BiquadType::Notch; return true; }
    if (tok == "AP") { outType = BiquadType::AllPass; return true; }
    return false;
}

inline PeqConfigSnapshot ParsePeqSpec(const std::string& spec) {
    PeqConfigSnapshot p;
    if (spec.empty()) return p;

    // Wire format: "<preampDb>;<TYPE>,<Fc>,<Q>,<Gain>;..." (up to 32 bands)
    size_t start = 0;
    size_t segIdx = 0;
    while (start <= spec.size()) {
        const size_t sep = spec.find(';', start);
        const std::string seg = (sep == std::string::npos) ? spec.substr(start) : spec.substr(start, sep - start);
        if (segIdx == 0) {
            if (!seg.empty()) {
                p.preampDb = ClampDouble(std::strtod(seg.c_str(), nullptr), -30.0, 18.0);
                if (!std::isfinite(p.preampDb)) p.preampDb = 0.0;
            }
        } else if (!seg.empty() && p.bandCount < MAX_PEQ_BANDS) {
            std::string parts[4];
            size_t pStart = 0;
            int pi = 0;
            while (pStart <= seg.size() && pi < 4) {
                const size_t c = seg.find(',', pStart);
                parts[pi++] = (c == std::string::npos) ? seg.substr(pStart) : seg.substr(pStart, c - pStart);
                if (c == std::string::npos) break;
                pStart = c + 1;
            }
            BiquadType bt = BiquadType::PeakingEq;
            if (pi >= 3 && ParsePeqTypeToken(parts[0], bt)) {
                PeqBandSpec band{};
                band.type = bt;
                band.freqHz = std::strtod(parts[1].c_str(), nullptr);
                band.q = std::strtod(parts[2].c_str(), nullptr);
                band.gainDb = (pi >= 4) ? std::strtod(parts[3].c_str(), nullptr) : 0.0;
                if (std::isfinite(band.freqHz) && band.freqHz >= 10.0 &&
                    std::isfinite(band.q) && band.q > 0.0 &&
                    std::isfinite(band.gainDb)) {
                    band.q = ClampDouble(band.q, 0.05, 30.0);
                    band.gainDb = ClampDouble(band.gainDb, -30.0, 30.0);
                    p.bands[p.bandCount++] = band;
                }
            }
        }
        ++segIdx;
        if (sep == std::string::npos) break;
        start = sep + 1;
    }
    p.enabled = (p.bandCount > 0 || std::fabs(p.preampDb) >= 0.01);
    return p;
}

DspConfigSnapshot ParseDspSpec(const std::string& spec) {
    DspConfigSnapshot cfg;
    if (spec.empty()) return cfg;

    // Expected wire format: "b0,b1,...,b9|bassFlag|bassDb|crossfeedFlag|crossfeedPct|limiterFlag"
    std::vector<std::string> fields;
    size_t start = 0;
    while (start <= spec.size()) {
        size_t sep = spec.find('|', start);
        if (sep == std::string::npos) {
            fields.push_back(spec.substr(start));
            break;
        }
        fields.push_back(spec.substr(start, sep - start));
        start = sep + 1;
    }

    if (!fields.empty() && !fields[0].empty()) {
        size_t bStart = 0;
        int idx = 0;
        while (bStart <= fields[0].size() && idx < 10) {
            size_t comma = fields[0].find(',', bStart);
            std::string tok = (comma == std::string::npos)
                ? fields[0].substr(bStart)
                : fields[0].substr(bStart, comma - bStart);
            cfg.bandGains[idx++] = ClampDouble(std::strtod(tok.c_str(), nullptr), -12.0, 12.0);
            if (comma == std::string::npos) break;
            bStart = comma + 1;
        }
    }
    if (fields.size() > 1) cfg.bass = std::strtol(fields[1].c_str(), nullptr, 10) != 0;
    if (fields.size() > 2) cfg.bassDb = ClampDouble(std::strtod(fields[2].c_str(), nullptr), 0.0, 9.0);
    if (fields.size() > 3) cfg.crossfeed = std::strtol(fields[3].c_str(), nullptr, 10) != 0;
    if (fields.size() > 4) cfg.crossfeedPct = ClampDouble(std::strtod(fields[4].c_str(), nullptr), 0.0, 100.0);
    if (fields.size() > 5) cfg.limiter = std::strtol(fields[5].c_str(), nullptr, 10) != 0;
    return cfg;
}

struct PurePathDspRack64 {
    DspConfigSnapshot cfg;
    Biquad64 eq[10];
    Biquad64 peq[MAX_PEQ_BANDS];
    size_t activePeqCount = 0;
    double peqPreampGain = 1.0;
    Biquad64 subBassLowShelf;
    Biquad64 subBassPunch;
    Biquad64 xfLowPassL;
    Biquad64 xfLowPassR;

    static constexpr size_t XF_MAX_DELAY = 512;
    double xfDelayL[XF_MAX_DELAY] = {};
    double xfDelayR[XF_MAX_DELAY] = {};
    size_t xfWritePos = 0;
    size_t xfDelaySamples = 12;
    double xfDirectGain = 1.0;
    double xfCrossGain = 0.0;
    double preampGain = 1.0;

    void ResetStates() {
        for (int i = 0; i < 10; ++i) eq[i].ResetState();
        for (size_t p = 0; p < MAX_PEQ_BANDS; ++p) peq[p].ResetState();
        subBassLowShelf.ResetState();
        subBassPunch.ResetState();
        xfLowPassL.ResetState();
        xfLowPassR.ResetState();
        std::memset(xfDelayL, 0, sizeof(xfDelayL));
        std::memset(xfDelayR, 0, sizeof(xfDelayR));
        xfWritePos = 0;
    }

    void ApplyConfig(uint32_t sampleRate, const DspConfigSnapshot& nextCfg) {
        cfg = nextCfg;
        double maxPosBoost = 0.0;
        for (int i = 0; i < 10; ++i) {
            const double gainDb = cfg.bandGains[i];
            if (gainDb > maxPosBoost) maxPosBoost = gainDb;
            const BiquadType t = (i == 0)
                ? BiquadType::LowShelf
                : (i == 9 ? BiquadType::HighShelf : BiquadType::PeakingEq);
            const double q = (i == 0 || i == 9) ? 0.70710678 : 1.15;
            eq[i].Configure(t, sampleRate, PUREPATH_EQ_FREQS[i], q, gainDb);
        }

        if (cfg.peq.enabled) {
            peqPreampGain = std::pow(10.0, ClampDouble(cfg.peq.preampDb, -30.0, 18.0) / 20.0);
            activePeqCount = std::min(cfg.peq.bandCount, MAX_PEQ_BANDS);
            for (size_t i = 0; i < MAX_PEQ_BANDS; ++i) {
                if (i < activePeqCount) {
                    const PeqBandSpec& b = cfg.peq.bands[i];
                    peq[i].Configure(b.type, sampleRate, b.freqHz, b.q, b.gainDb);
                } else {
                    peq[i].bypass = true;
                }
            }
        } else {
            peqPreampGain = 1.0;
            activePeqCount = 0;
            for (size_t i = 0; i < MAX_PEQ_BANDS; ++i) {
                peq[i].bypass = true;
            }
        }

        const double eqHeadroom = (maxPosBoost > 0.5)
            ? std::pow(10.0, -std::min(5.0, maxPosBoost * 0.4) / 20.0)
            : 1.0;

        const double subShelfDb = cfg.bass ? cfg.bassDb : 0.0;
        const double punchDb = subShelfDb * 0.45;
        const double bassHeadroom = cfg.bass
            ? std::pow(10.0, -std::min(3.5, subShelfDb * 0.25) / 20.0)
            : 1.0;

        subBassLowShelf.Configure(BiquadType::LowShelf, sampleRate, 70.0, 0.70710678, subShelfDb);
        subBassPunch.Configure(BiquadType::PeakingEq, sampleRate, 120.0, 1.05, punchDb);
        preampGain = eqHeadroom * bassHeadroom * peqPreampGain;

        if (cfg.crossfeed) {
            const double norm = cfg.crossfeedPct / 100.0;
            xfCrossGain = 0.12 + norm * 0.34;
            xfDirectGain = std::sqrt(std::max(0.25, 1.0 - xfCrossGain * xfCrossGain));
            xfLowPassL.Configure(BiquadType::LowPass, sampleRate, 700.0, 0.70710678, 0.0);
            xfLowPassR.Configure(BiquadType::LowPass, sampleRate, 700.0, 0.70710678, 0.0);
            const double sr = static_cast<double>(sampleRate >= 8000 ? sampleRate : 48000);
            const size_t d = static_cast<size_t>(std::llround(0.00026 * sr));
            xfDelaySamples = (d < 1) ? 1 : (d >= XF_MAX_DELAY ? XF_MAX_DELAY - 1 : d);
        } else {
            xfDirectGain = 1.0;
            xfCrossGain = 0.0;
            xfLowPassL.bypass = true;
            xfLowPassR.bypass = true;
        }
    }

    inline void ProcessFrame(double* samples, uint32_t chCount) {
        for (uint32_t ch = 0; ch < chCount; ++ch) {
            double s = samples[ch] * preampGain;
            for (int b = 0; b < 10; ++b) {
                if (!eq[b].bypass) s = eq[b].ProcessSample(s, ch);
            }
            for (size_t p = 0; p < activePeqCount; ++p) {
                if (!peq[p].bypass) s = peq[p].ProcessSample(s, ch);
            }
            if (!subBassLowShelf.bypass) s = subBassLowShelf.ProcessSample(s, ch);
            if (!subBassPunch.bypass) s = subBassPunch.ProcessSample(s, ch);
            samples[ch] = s;
        }

        if (cfg.crossfeed && chCount >= 2) {
            const double inL = samples[0];
            const double inR = samples[1];
            const double lpL = xfLowPassL.ProcessSample(inL, 0);
            const double lpR = xfLowPassR.ProcessSample(inR, 0);

            xfDelayL[xfWritePos] = lpL;
            xfDelayR[xfWritePos] = lpR;
            const size_t readPos = (xfWritePos + XF_MAX_DELAY - xfDelaySamples) % XF_MAX_DELAY;
            const double bleedFromL = xfDelayL[readPos];
            const double bleedFromR = xfDelayR[readPos];
            xfWritePos = (xfWritePos + 1) % XF_MAX_DELAY;

            samples[0] = inL * xfDirectGain + bleedFromR * xfCrossGain;
            samples[1] = inR * xfDirectGain + bleedFromL * xfCrossGain;
        }
    }
};

struct TruePeakLimiter64 {
    bool enabled = false;
    double ceiling = 0.9660508789; // -0.3 dBFS
    double envelopeGain = 1.0;
    double attackCoeff = 0.25;
    double releaseCoeff = 0.9998;
    double hist[MAX_AUDIO_CHANNELS][4] = {};

    void Configure(uint32_t sampleRate, double ceilingDbfs = -0.3) {
        const double sr = static_cast<double>(sampleRate > 0 ? sampleRate : 48000);
        ceiling = std::pow(10.0, ceilingDbfs / 20.0);
        // Fast ~0.15ms attack catches inter-sample peaks cleanly; 120ms transparent release avoids pumping
        attackCoeff = std::exp(-1.0 / (0.00015 * sr));
        releaseCoeff = std::exp(-1.0 / (0.120 * sr));
    }

    void Reset() {
        envelopeGain = 1.0;
        for (size_t ch = 0; ch < MAX_AUDIO_CHANNELS; ++ch) {
            for (size_t k = 0; k < 4; ++k) hist[ch][k] = 0.0;
        }
    }

    static double HermiteAt(double ym1, double y0, double y1, double y2, double frac) {
        const double c0 = y0;
        const double c1 = 0.5 * (y1 - ym1);
        const double c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
        const double c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
        return ((c3 * frac + c2) * frac + c1) * frac + c0;
    }

    // 4x oversampled stereo/multichannel-linked true-peak limiter with smooth lookahead-style envelope
    void ProcessFrame(double* samples, uint32_t channels) {
        const uint32_t chCount = channels < MAX_AUDIO_CHANNELS ? channels : static_cast<uint32_t>(MAX_AUDIO_CHANNELS);
        double maxPeak = 0.0;

        for (uint32_t ch = 0; ch < chCount; ++ch) {
            hist[ch][0] = hist[ch][1];
            hist[ch][1] = hist[ch][2];
            hist[ch][2] = hist[ch][3];
            hist[ch][3] = samples[ch];

            const double absCur = std::fabs(samples[ch]);
            if (absCur > maxPeak) maxPeak = absCur;

            // Evaluate 4x inter-sample peaks between hist[1] and hist[2] using cubic Hermite polynomial
            const double p1 = std::fabs(HermiteAt(hist[ch][0], hist[ch][1], hist[ch][2], hist[ch][3], 0.25));
            const double p2 = std::fabs(HermiteAt(hist[ch][0], hist[ch][1], hist[ch][2], hist[ch][3], 0.50));
            const double p3 = std::fabs(HermiteAt(hist[ch][0], hist[ch][1], hist[ch][2], hist[ch][3], 0.75));
            if (p1 > maxPeak) maxPeak = p1;
            if (p2 > maxPeak) maxPeak = p2;
            if (p3 > maxPeak) maxPeak = p3;
        }

        const double targetGain = (maxPeak > ceiling && maxPeak > 1e-12) ? (ceiling / maxPeak) : 1.0;
        const double coeff = (targetGain < envelopeGain) ? attackCoeff : releaseCoeff;
        envelopeGain = coeff * envelopeGain + (1.0 - coeff) * targetGain;
        const double effectiveGain = envelopeGain < targetGain ? envelopeGain : targetGain;

        for (uint32_t ch = 0; ch < chCount; ++ch) {
            double out = samples[ch] * effectiveGain;
            // Final brickwall guard against transient overshoot beyond +/-ceiling
            if (out > ceiling) out = ceiling;
            if (out < -ceiling) out = -ceiling;
            samples[ch] = out;
        }
    }
};

struct TpdfDitherShaper64 {
    uint64_t rngState[MAX_AUDIO_CHANNELS] = {};
    double errState[MAX_AUDIO_CHANNELS] = {};

    TpdfDitherShaper64() {
        Reset();
    }

    void Reset() {
        for (size_t ch = 0; ch < MAX_AUDIO_CHANNELS; ++ch) {
            rngState[ch] = 0x243F6A8885A308D3ULL + static_cast<uint64_t>(ch + 1) * 0x9E3779B97F4A7C15ULL;
            errState[ch] = 0.0;
        }
    }

    inline double NextUniform01(uint32_t ch) {
        const size_t idx = ch < MAX_AUDIO_CHANNELS ? static_cast<size_t>(ch) : 0;
        uint64_t x = rngState[idx];
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        rngState[idx] = x;
        const uint64_t r = x * 0x2545F4914F6CDD1DULL;
        // Convert upper 53 bits directly into IEEE-754 double in [0, 1)
        return static_cast<double>(r >> 11) * (1.0 / 9007199254740992.0);
    }

    inline int32_t Quantize24(double sample, uint32_t ch) {
        const size_t idx = ch < MAX_AUDIO_CHANNELS ? static_cast<size_t>(ch) : 0;
        const double lsb = 1.0 / 8388608.0;
        // 1st-order noise shaping (0.5 error feedback) + TPDF dither ([-1, +1] LSB triangular PDF)
        const double shaped = sample + 0.5 * errState[idx];
        const double tpdf = (NextUniform01(ch) - NextUniform01(ch)) * lsb;
        const double q = std::floor((shaped + tpdf) * 8388608.0 + 0.5);
        const double clamped = ClampDouble(q, -8388608.0, 8388607.0);
        const double reconstructed = clamped / 8388608.0;
        errState[idx] = ClampDouble(shaped - reconstructed, -lsb, lsb);
        return static_cast<int32_t>(clamped);
    }

    inline int16_t Quantize16(double sample, uint32_t ch) {
        const size_t idx = ch < MAX_AUDIO_CHANNELS ? static_cast<size_t>(ch) : 0;
        const double lsb = 1.0 / 32768.0;
        const double shaped = sample + 0.5 * errState[idx];
        const double tpdf = (NextUniform01(ch) - NextUniform01(ch)) * lsb;
        const double q = std::floor((shaped + tpdf) * 32768.0 + 0.5);
        const double clamped = ClampDouble(q, -32768.0, 32767.0);
        const double reconstructed = clamped / 32768.0;
        errState[idx] = ClampDouble(shaped - reconstructed, -lsb, lsb);
        return static_cast<int16_t>(clamped);
    }
};

inline void AccumulateTelemetrySample(double normalized, uint32_t ch, uint32_t channels, TelemetryFrameStats& stats) {
    const float absVal = static_cast<float>(std::fabs(normalized));
    if (ch == 0) {
        if (absVal > stats.lPeak) stats.lPeak = absVal;
        stats.lSumSq += normalized * normalized;
        if (channels == 1) {
            if (absVal > stats.rPeak) stats.rPeak = absVal;
            stats.rSumSq += normalized * normalized;
        }
    } else if (ch == 1) {
        if (absVal > stats.rPeak) stats.rPeak = absVal;
        stats.rSumSq += normalized * normalized;
    }
}

inline uint32_t EmitDitheredOrFloatSample(
    BYTE* pOut,
    size_t sampleIndex,
    double normalized,
    uint32_t ch,
    WireSampleFormat wireFmt,
    TpdfDitherShaper64& dither) {
    switch (wireFmt) {
        case WireSampleFormat::Float32: {
            float* fOut = reinterpret_cast<float*>(pOut);
            fOut[sampleIndex] = static_cast<float>(normalized);
            const double q32 = ClampDouble(std::floor(normalized * 2147483648.0 + 0.5), -2147483648.0, 2147483647.0);
            return static_cast<uint32_t>(static_cast<int32_t>(static_cast<int64_t>(q32)));
        }
        case WireSampleFormat::Pcm32: {
            int32_t* iOut = reinterpret_cast<int32_t*>(pOut);
            const double q32 = ClampDouble(std::floor(normalized * 2147483648.0 + 0.5), -2147483648.0, 2147483647.0);
            const int32_t s32 = static_cast<int32_t>(static_cast<int64_t>(q32));
            iOut[sampleIndex] = s32;
            return static_cast<uint32_t>(s32);
        }
        case WireSampleFormat::Pcm24In32: {
            int32_t* iOut = reinterpret_cast<int32_t*>(pOut);
            const int32_t s24 = dither.Quantize24(normalized, ch);
            const uint32_t w32 = static_cast<uint32_t>(s24) << 8;
            iOut[sampleIndex] = static_cast<int32_t>(w32);
            return w32;
        }
        case WireSampleFormat::Pcm24Packed: {
            const uint32_t u24 = static_cast<uint32_t>(dither.Quantize24(normalized, ch));
            BYTE* b = pOut + sampleIndex * 3;
            b[0] = static_cast<BYTE>(u24 & 0xFFu);
            b[1] = static_cast<BYTE>((u24 >> 8) & 0xFFu);
            b[2] = static_cast<BYTE>((u24 >> 16) & 0xFFu);
            return (u24 << 8);
        }
        case WireSampleFormat::Pcm16: {
            int16_t* sOut = reinterpret_cast<int16_t*>(pOut);
            const int16_t s16 = dither.Quantize16(normalized, ch);
            sOut[sampleIndex] = s16;
            return static_cast<uint32_t>(static_cast<uint16_t>(s16)) << 16;
        }
    }
    return 0u;
}

template <typename SampleT>
inline double SampleToNormalizedDouble(SampleT s) {
    if constexpr (std::is_floating_point_v<SampleT>) {
        return static_cast<double>(s);
    } else {
        return static_cast<double>(s) / 2147483648.0;
    }
}

template <typename SampleT>
void ConvertAndWriteFramesImpl(
    BYTE* pOut,
    const SampleT* pIn,
    uint32_t frames,
    uint32_t channels,
    WireSampleFormat wireFmt,
    float gain,
    uint16_t srcBits,
    PurePathDspRack64& dspRack,
    TruePeakLimiter64& limiter,
    TpdfDitherShaper64& dither,
    float* fftRing,
    size_t& fftWritePos,
    TelemetryFrameStats& stats,
    vanta_convolver::ConvolverSlot64* convolver = nullptr,
    AudioAnalysisMeters64* meters = nullptr,
    uint32_t sampleRate = 48000) {
    constexpr bool inIsFloat = std::is_floating_point_v<SampleT>;
    const double g = static_cast<double>(gain);
    const bool hasToneOrEq = dspRack.cfg.HasEqOrTone();
    const bool convolverActive = (convolver != nullptr && convolver->enabled);
    const bool needs16BitDither = (wireFmt == WireSampleFormat::Pcm16) && (inIsFloat || srcBits > 16);
    const bool isBitExactPath = !inIsFloat &&
        !hasToneOrEq &&
        !convolverActive &&
        !dspRack.cfg.limiter &&
        std::fabs(g - 1.0) < 1e-6 &&
        wireFmt != WireSampleFormat::Float32 &&
        !needs16BitDither;

    if constexpr (!inIsFloat) {
        if (isBitExactPath) {
            for (uint32_t f = 0; f < frames; ++f) {
                double mono = 0.0;
                for (uint32_t ch = 0; ch < channels; ++ch) {
                    const size_t i = static_cast<size_t>(f) * channels + ch;
                    const int32_t raw = pIn[i];
                    const double normalized = ClampDouble(static_cast<double>(raw) / 2147483648.0, -1.0, 1.0);
                    mono += normalized;
                    AccumulateTelemetrySample(normalized, ch, channels, stats);

                    const uint32_t u = static_cast<uint32_t>(raw);
                    uint32_t wireMask = u;
                    switch (wireFmt) {
                        case WireSampleFormat::Pcm32: {
                            int32_t* iOut = reinterpret_cast<int32_t*>(pOut);
                            iOut[i] = raw;
                            break;
                        }
                        case WireSampleFormat::Pcm24In32: {
                            int32_t* iOut = reinterpret_cast<int32_t*>(pOut);
                            wireMask = (u & 0xFFFFFF00u);
                            iOut[i] = static_cast<int32_t>(wireMask);
                            break;
                        }
                        case WireSampleFormat::Pcm24Packed: {
                            BYTE* b = pOut + i * 3;
                            b[0] = static_cast<BYTE>((u >> 8) & 0xFFu);
                            b[1] = static_cast<BYTE>((u >> 16) & 0xFFu);
                            b[2] = static_cast<BYTE>((u >> 24) & 0xFFu);
                            wireMask = (u & 0xFFFFFF00u);
                            break;
                        }
                        case WireSampleFormat::Pcm16: {
                            int16_t* sOut = reinterpret_cast<int16_t*>(pOut);
                            sOut[i] = static_cast<int16_t>((u >> 16) & 0xFFFFu);
                            wireMask = (u & 0xFFFF0000u);
                            break;
                        }
                        case WireSampleFormat::Float32:
                            break;
                    }
                    if (meters) {
                        meters->PushOutputSample(normalized, ch, u, wireMask);
                    }
                }
                if (meters) meters->AdvanceFrame(channels, sampleRate);
                fftRing[fftWritePos] = static_cast<float>(mono / static_cast<double>(channels > 0 ? channels : 1));
                fftWritePos = (fftWritePos + 1) % FFT_N;
            }
            stats.frameCount += frames;
            return;
        }
    }

    const uint32_t activeCh = channels < MAX_AUDIO_CHANNELS ? channels : static_cast<uint32_t>(MAX_AUDIO_CHANNELS);
    const bool useTruePeakLimiter = dspRack.cfg.limiter || convolverActive || g > 1.0001 || dspRack.cfg.NeedsHeadroomProtection();
    double frameWork[MAX_AUDIO_CHANNELS] = {};

    for (uint32_t f = 0; f < frames; ++f) {
        for (uint32_t ch = 0; ch < activeCh; ++ch) {
            const size_t i = static_cast<size_t>(f) * channels + ch;
            frameWork[ch] = SampleToNormalizedDouble(pIn[i]) * g;
        }

        if (hasToneOrEq) {
            dspRack.ProcessFrame(frameWork, activeCh);
        }

        if (convolverActive) {
            if (activeCh >= 2) {
                convolver->ProcessStereoFrame(frameWork[0], frameWork[1]);
            } else if (activeCh == 1) {
                double dummyR = frameWork[0];
                convolver->ProcessStereoFrame(frameWork[0], dummyR);
            }
        }

        if (useTruePeakLimiter) {
            limiter.ProcessFrame(frameWork, activeCh);
        }

        double mono = 0.0;
        for (uint32_t ch = 0; ch < channels; ++ch) {
            const size_t i = static_cast<size_t>(f) * channels + ch;
            double normalized = ch < activeCh ? frameWork[ch] : SampleToNormalizedDouble(pIn[i]) * g;
            normalized = ClampDouble(normalized, -1.0, 1.0);
            mono += normalized;
            AccumulateTelemetrySample(normalized, ch, channels, stats);
            const uint32_t wireMask = EmitDitheredOrFloatSample(pOut, i, normalized, ch, wireFmt, dither);
            if (meters) {
                uint32_t srcWord = 0u;
                if constexpr (!inIsFloat) {
                    srcWord = static_cast<uint32_t>(pIn[i]);
                } else {
                    const double qSrc = ClampDouble(std::floor(ClampDouble(static_cast<double>(pIn[i]), -1.0, 1.0) * 2147483648.0 + 0.5), -2147483648.0, 2147483647.0);
                    srcWord = static_cast<uint32_t>(static_cast<int32_t>(static_cast<int64_t>(qSrc)));
                }
                meters->PushOutputSample(normalized, ch, srcWord, wireMask);
            }
        }
        if (meters) meters->AdvanceFrame(channels, sampleRate);
        fftRing[fftWritePos] = static_cast<float>(mono / static_cast<double>(channels > 0 ? channels : 1));
        fftWritePos = (fftWritePos + 1) % FFT_N;
    }
    stats.frameCount += frames;
}

void ConvertAndWriteFrames(
    BYTE* pOut,
    const int32_t* pIn,
    uint32_t frames,
    uint32_t channels,
    WireSampleFormat wireFmt,
    float gain,
    PurePathDspRack64& dspRack,
    TruePeakLimiter64& limiter,
    TpdfDitherShaper64& dither,
    float* fftRing,
    size_t& fftWritePos,
    TelemetryFrameStats& stats,
    uint16_t srcBits = 24,
    vanta_convolver::ConvolverSlot64* convolver = nullptr,
    AudioAnalysisMeters64* meters = nullptr,
    uint32_t sampleRate = 48000) {
    ConvertAndWriteFramesImpl<int32_t>(
        pOut, pIn, frames, channels, wireFmt, gain, srcBits, dspRack, limiter, dither, fftRing, fftWritePos, stats, convolver, meters, sampleRate
    );
}

void ConvertAndWriteFloatFrames(
    BYTE* pOut,
    const double* pIn,
    uint32_t frames,
    uint32_t channels,
    WireSampleFormat wireFmt,
    float gain,
    PurePathDspRack64& dspRack,
    TruePeakLimiter64& limiter,
    TpdfDitherShaper64& dither,
    float* fftRing,
    size_t& fftWritePos,
    TelemetryFrameStats& stats,
    uint16_t srcBits = 32,
    vanta_convolver::ConvolverSlot64* convolver = nullptr,
    AudioAnalysisMeters64* meters = nullptr,
    uint32_t sampleRate = 48000) {
    ConvertAndWriteFramesImpl<double>(
        pOut, pIn, frames, channels, wireFmt, gain, srcBits, dspRack, limiter, dither, fftRing, fftWritePos, stats, convolver, meters, sampleRate
    );
}

constexpr std::array<uint8_t, 256> BuildBitReverseLut() {
    std::array<uint8_t, 256> lut{};
    for (size_t i = 0; i < 256; ++i) {
        uint8_t b = static_cast<uint8_t>(i);
        uint8_t r = 0;
        for (int bit = 0; bit < 8; ++bit) {
            if (b & (1u << bit)) {
                r |= static_cast<uint8_t>(1u << (7 - bit));
            }
        }
        lut[i] = r;
    }
    return lut;
}

constexpr std::array<uint8_t, 256> BuildPopcountLut() {
    std::array<uint8_t, 256> lut{};
    for (size_t i = 0; i < 256; ++i) {
        uint8_t v = static_cast<uint8_t>(i);
        uint8_t cnt = 0;
        for (int bit = 0; bit < 8; ++bit) {
            if (v & (1u << bit)) ++cnt;
        }
        lut[i] = cnt;
    }
    return lut;
}

constexpr std::array<uint8_t, 256> BIT_REVERSE_LUT = BuildBitReverseLut();
constexpr std::array<uint8_t, 256> POPCOUNT_LUT = BuildPopcountLut();

inline uint32_t PackDopWord24(uint64_t carrierFrameIdx, uint8_t b0, uint8_t b1) {
    const uint32_t marker = ((carrierFrameIdx & 1ULL) == 0ULL) ? 0x05u : 0xFAu;
    return (marker << 16) | (static_cast<uint32_t>(b0) << 8) | static_cast<uint32_t>(b1);
}

inline uint16_t ReadU16BE(const uint8_t* p) {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

inline uint32_t ReadU32LE(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

inline uint64_t ReadU64LE(const uint8_t* p) {
    return static_cast<uint64_t>(ReadU32LE(p)) |
           (static_cast<uint64_t>(ReadU32LE(p + 4)) << 32);
}

inline uint32_t ReadU32BE(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) |
           (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) |
           static_cast<uint32_t>(p[3]);
}

inline uint64_t ReadU64BE(const uint8_t* p) {
    return (static_cast<uint64_t>(ReadU32BE(p)) << 32) |
           static_cast<uint64_t>(ReadU32BE(p + 4));
}

std::string DsdRateLabelForClock(uint32_t dsdRate) {
    if (dsdRate == 2822400u || dsdRate == 3072000u) return "DSD64";
    if (dsdRate == 5644800u || dsdRate == 6144000u) return "DSD128";
    if (dsdRate == 11289600u || dsdRate == 12288000u) return "DSD256";
    if (dsdRate == 22579200u || dsdRate == 24576000u) return "DSD512";
    if (dsdRate == 45158400u || dsdRate == 49152000u) return "DSD1024";
    return "DSD";
}

class DopStreamReader {
public:
    enum class ContainerType { None, Dsf, Dff };

    ~DopStreamReader() {
        Close();
    }

    void Close() {
        if (m_fp) {
            std::fclose(m_fp);
            m_fp = nullptr;
        }
    }

    bool Open(const std::string& path, double seekSec, std::string& outErr, bool allowRawHighDsd = false) {
        Close();
        const std::wstring wid = Utf8ToWide(path);
        if (_wfopen_s(&m_fp, wid.c_str(), L"rb") != 0 || !m_fp) {
            outErr = "Failed opening DSD file";
            return false;
        }

        uint8_t magic[4] = {};
        if (std::fread(magic, 1, 4, m_fp) != 4) {
            outErr = "Empty DSD file";
            Close();
            return false;
        }
        _fseeki64(m_fp, 0, SEEK_SET);

        bool ok = false;
        if (std::memcmp(magic, "DSD ", 4) == 0) {
            ok = ParseDsf(outErr);
        } else if (std::memcmp(magic, "FRM8", 4) == 0) {
            ok = ParseDff(outErr);
        } else {
            outErr = "Unsupported DSD container header (expected DSF or DFF)";
        }

        if (!ok) {
            Close();
            return false;
        }

        if (m_channels < 1 || m_channels > 8) {
            outErr = "Unsupported DSD channel count";
            Close();
            return false;
        }
        if (m_dsdSampleRate == 0 || (m_dsdSampleRate % 16u) != 0) {
            outErr = "Invalid DSD sample rate";
            Close();
            return false;
        }
        m_carrierRate = m_dsdSampleRate / 16u;
        m_dsdLabel = DsdRateLabelForClock(m_dsdSampleRate);

        if (!allowRawHighDsd && m_carrierRate > 768000u) {
            outErr = "DoP carrier rate exceeds 768 kHz (" + m_dsdLabel + " requires native ASIO or DXD PCM fallback)";
            Close();
            return false;
        }

        if (seekSec > 0.0) {
            if (allowRawHighDsd) {
                const uint64_t targetOctetFrames = static_cast<uint64_t>(
                    (seekSec * static_cast<double>(m_dsdSampleRate)) / 8.0
                );
                SeekToCarrierFrame(targetOctetFrames / 2ULL);
            } else {
                const uint64_t targetFrames = static_cast<uint64_t>(
                    (seekSec * static_cast<double>(m_dsdSampleRate)) / 16.0
                );
                SeekToCarrierFrame(targetFrames);
            }
        }
        return true;
    }

    // Reads up to maxOctetFrames of interleaved 8-bit DSD octets per channel (native ASIO DSD64..DSD1024).
    size_t ReadRawDsdOctetFrames(uint8_t* dst, size_t maxOctetFrames, bool targetMsbFirst) {
        if (!m_fp || !dst) return 0;
        const uint64_t totalOctets = m_totalCarrierFrames * 2ULL;
        if (m_octetsRead >= totalOctets) return 0;
        const bool needReverse = (m_lsbFirst == targetMsbFirst);
        size_t written = 0;

        if (m_container == ContainerType::Dsf) {
            while (written < maxOctetFrames && m_octetsRead < totalOctets) {
                for (uint16_t ch = 0; ch < m_channels; ++ch) {
                    uint8_t b = 0;
                    if (!ReadDsfByte(ch, b)) return written;
                    dst[written * m_channels + ch] = needReverse ? BIT_REVERSE_LUT[b] : b;
                }
                ++m_octetsRead;
                ++written;
            }
        } else if (m_container == ContainerType::Dff) {
            const uint64_t availOctets = totalOctets - m_octetsRead;
            const size_t toRead = static_cast<size_t>(std::min<uint64_t>(maxOctetFrames, availOctets));
            const size_t rowBytes = m_channels;
            if (m_dffScratch.size() < toRead * rowBytes) {
                m_dffScratch.resize(toRead * rowBytes);
            }
            const size_t gotFrames = std::fread(m_dffScratch.data(), rowBytes, toRead, m_fp);
            for (size_t f = 0; f < gotFrames; ++f) {
                for (uint16_t ch = 0; ch < m_channels; ++ch) {
                    const uint8_t b = m_dffScratch[f * rowBytes + ch];
                    dst[f * rowBytes + ch] = needReverse ? BIT_REVERSE_LUT[b] : b;
                }
            }
            m_octetsRead += gotFrames;
            written = gotFrames;
        }
        return written;
    }

    // Reads up to maxFrames of packed DoP 24-bit words per channel into dst (stored in low 24 bits of int32_t)
    size_t ReadCarrierFrames(int32_t* dst, size_t maxFrames) {
        if (!m_fp || m_framesRead >= m_totalCarrierFrames) return 0;

        size_t written = 0;
        if (m_container == ContainerType::Dsf) {
            while (written < maxFrames && m_framesRead < m_totalCarrierFrames) {
                for (uint16_t ch = 0; ch < m_channels; ++ch) {
                    uint8_t b0 = 0;
                    uint8_t b1 = 0;
                    if (!ReadDsfByte(ch, b0) || !ReadDsfByte(ch, b1)) {
                        return written;
                    }
                    if (m_lsbFirst) {
                        b0 = BIT_REVERSE_LUT[b0];
                        b1 = BIT_REVERSE_LUT[b1];
                    }
                    const uint32_t word24 = PackDopWord24(m_carrierFrameIndex, b0, b1);
                    dst[written * m_channels + ch] = static_cast<int32_t>(word24);
                }
                ++m_carrierFrameIndex;
                ++m_framesRead;
                ++written;
            }
        } else if (m_container == ContainerType::Dff) {
            const uint64_t availFrames = m_totalCarrierFrames - m_framesRead;
            const size_t toRead = static_cast<size_t>(std::min<uint64_t>(maxFrames, availFrames));
            const size_t pairBytes = static_cast<size_t>(m_channels) * 2u;
            if (m_dffScratch.size() < toRead * pairBytes) {
                m_dffScratch.resize(toRead * pairBytes);
            }
            const size_t gotFrames = std::fread(m_dffScratch.data(), pairBytes, toRead, m_fp);
            for (size_t f = 0; f < gotFrames; ++f) {
                const uint8_t* slice0 = m_dffScratch.data() + f * pairBytes;
                const uint8_t* slice1 = slice0 + m_channels;
                for (uint16_t ch = 0; ch < m_channels; ++ch) {
                    // Philips DSDIFF is already MSB-first and byte-interleaved across channels
                    const uint32_t word24 = PackDopWord24(m_carrierFrameIndex, slice0[ch], slice1[ch]);
                    dst[f * m_channels + ch] = static_cast<int32_t>(word24);
                }
                ++m_carrierFrameIndex;
                ++m_framesRead;
                ++written;
            }
        }
        return written;
    }

    ContainerType FormatType() const { return m_container; }
    std::string FormatName() const { return m_container == ContainerType::Dsf ? "DSF" : "DFF"; }
    std::string DsdLabel() const { return m_dsdLabel; }
    uint32_t DsdSampleRate() const { return m_dsdSampleRate; }
    uint32_t CarrierRate() const { return m_carrierRate; }
    uint16_t Channels() const { return m_channels; }
    uint64_t TotalCarrierFrames() const { return m_totalCarrierFrames; }

private:
    bool ParseDsf(std::string& outErr) {
        uint8_t dsdHdr[28] = {};
        if (std::fread(dsdHdr, 1, sizeof(dsdHdr), m_fp) != sizeof(dsdHdr)) {
            outErr = "Truncated DSF DSD header";
            return false;
        }
        const uint64_t dsdChunkSize = ReadU64LE(dsdHdr + 4);
        if (dsdChunkSize > sizeof(dsdHdr)) {
            _fseeki64(m_fp, static_cast<__int64>(dsdChunkSize), SEEK_SET);
        }

        uint8_t fmtHdr[52] = {};
        if (std::fread(fmtHdr, 1, sizeof(fmtHdr), m_fp) != sizeof(fmtHdr) || std::memcmp(fmtHdr, "fmt ", 4) != 0) {
            outErr = "Missing DSF fmt chunk";
            return false;
        }
        const uint64_t fmtChunkSize = ReadU64LE(fmtHdr + 4);
        if (fmtChunkSize < 52) {
            outErr = "Invalid DSF fmt chunk size";
            return false;
        }
        const uint32_t formatId = ReadU32LE(fmtHdr + 16);
        if (formatId != 0) {
            outErr = "Unsupported DSF compressed formatId";
            return false;
        }

        m_channels = static_cast<uint16_t>(ReadU32LE(fmtHdr + 24));
        m_dsdSampleRate = ReadU32LE(fmtHdr + 28);
        const uint32_t bitsPerSample = ReadU32LE(fmtHdr + 32);
        const uint64_t sampleCount = ReadU64LE(fmtHdr + 36);
        m_dsfBlockSize = ReadU32LE(fmtHdr + 44);
        m_lsbFirst = (bitsPerSample == 1);

        if (m_dsfBlockSize == 0 || m_dsfBlockSize > 1048576u) {
            outErr = "Invalid DSF blockSizePerChannel";
            return false;
        }
        if (fmtChunkSize > 52) {
            _fseeki64(m_fp, static_cast<__int64>(fmtChunkSize - 52), SEEK_CUR);
        }

        uint8_t dataHdr[12] = {};
        if (std::fread(dataHdr, 1, sizeof(dataHdr), m_fp) != sizeof(dataHdr) || std::memcmp(dataHdr, "data", 4) != 0) {
            outErr = "Missing DSF data chunk";
            return false;
        }
        const uint64_t dataChunkSize = ReadU64LE(dataHdr + 4);
        m_dataStartOffset = _ftelli64(m_fp);
        const uint64_t payloadBytes = (dataChunkSize > 12) ? (dataChunkSize - 12) : 0;
        const uint64_t framesFromSamples = sampleCount / 16ULL;
        const uint64_t framesFromBytes = payloadBytes / (static_cast<uint64_t>(m_channels) * 2ULL);
        m_totalCarrierFrames = (framesFromSamples > 0)
            ? std::min(framesFromSamples, framesFromBytes)
            : framesFromBytes;

        m_container = ContainerType::Dsf;
        m_dsfBlockBuf.resize(static_cast<size_t>(m_dsfBlockSize) * m_channels);
        m_dsfChBytePos.assign(m_channels, m_dsfBlockSize); // trigger initial block load
        return true;
    }

    bool EnsureDsfBlock() {
        const size_t totalBlockBytes = static_cast<size_t>(m_dsfBlockSize) * m_channels;
        const size_t got = std::fread(m_dsfBlockBuf.data(), 1, totalBlockBytes, m_fp);
        if (got < totalBlockBytes) {
            return false;
        }
        std::fill(m_dsfChBytePos.begin(), m_dsfChBytePos.end(), 0u);
        return true;
    }

    bool ReadDsfByte(uint16_t ch, uint8_t& outByte) {
        if (m_dsfChBytePos[ch] >= m_dsfBlockSize) {
            if (!EnsureDsfBlock()) return false;
        }
        const size_t offset = static_cast<size_t>(ch) * m_dsfBlockSize + m_dsfChBytePos[ch];
        outByte = m_dsfBlockBuf[offset];
        ++m_dsfChBytePos[ch];
        return true;
    }

    bool ParseDff(std::string& outErr) {
        uint8_t frmHdr[16] = {};
        if (std::fread(frmHdr, 1, sizeof(frmHdr), m_fp) != sizeof(frmHdr) ||
            std::memcmp(frmHdr, "FRM8", 4) != 0 ||
            std::memcmp(frmHdr + 12, "DSD ", 4) != 0) {
            outErr = "Invalid DSDIFF FRM8 header";
            return false;
        }
        const uint64_t frmDataSize = ReadU64BE(frmHdr + 4);
        const __int64 frmEnd = 12 + static_cast<__int64>(frmDataSize);

        bool gotRate = false;
        bool gotChnl = false;
        bool gotData = false;
        std::string cmprId = "DSD ";

        while (_ftelli64(m_fp) + 12 <= frmEnd) {
            uint8_t ckHdr[12] = {};
            if (std::fread(ckHdr, 1, sizeof(ckHdr), m_fp) != sizeof(ckHdr)) break;
            const uint64_t ckSize = ReadU64BE(ckHdr + 4);
            const __int64 ckDataStart = _ftelli64(m_fp);

            if (std::memcmp(ckHdr, "PROP", 4) == 0 && ckSize >= 4) {
                uint8_t propType[4] = {};
                if (std::fread(propType, 1, 4, m_fp) == 4 && std::memcmp(propType, "SND ", 4) == 0) {
                    const __int64 propEnd = ckDataStart + static_cast<__int64>(ckSize);
                    while (_ftelli64(m_fp) + 12 <= propEnd) {
                        uint8_t subHdr[12] = {};
                        if (std::fread(subHdr, 1, 12, m_fp) != 12) break;
                        const uint64_t subSize = ReadU64BE(subHdr + 4);
                        const __int64 subStart = _ftelli64(m_fp);

                        if (std::memcmp(subHdr, "FS  ", 4) == 0 && subSize >= 4) {
                            uint8_t srBuf[4] = {};
                            if (std::fread(srBuf, 1, 4, m_fp) == 4) {
                                m_dsdSampleRate = ReadU32BE(srBuf);
                                gotRate = true;
                            }
                        } else if (std::memcmp(subHdr, "CHNL", 4) == 0 && subSize >= 2) {
                            uint8_t chBuf[2] = {};
                            if (std::fread(chBuf, 1, 2, m_fp) == 2) {
                                m_channels = ReadU16BE(chBuf);
                                gotChnl = true;
                            }
                        } else if (std::memcmp(subHdr, "CMPR", 4) == 0 && subSize >= 4) {
                            char cBuf[4] = {};
                            if (std::fread(cBuf, 1, 4, m_fp) == 4) {
                                cmprId.assign(cBuf, 4);
                            }
                        }
                        const uint64_t padded = subSize + (subSize & 1ULL);
                        _fseeki64(m_fp, subStart + static_cast<__int64>(padded), SEEK_SET);
                    }
                }
            } else if (std::memcmp(ckHdr, "DSD ", 4) == 0) {
                m_dataStartOffset = ckDataStart;
                m_dffDataBytes = ckSize;
                gotData = true;
                break;
            }

            const uint64_t padded = ckSize + (ckSize & 1ULL);
            _fseeki64(m_fp, ckDataStart + static_cast<__int64>(padded), SEEK_SET);
        }

        if (cmprId != "DSD ") {
            outErr = "Compressed DSDIFF (" + cmprId + ") requires DXD PCM decoding";
            return false;
        }
        if (!gotRate || !gotChnl || !gotData || m_channels == 0) {
            outErr = "Incomplete DSDIFF metadata or audio chunk";
            return false;
        }

        m_totalCarrierFrames = m_dffDataBytes / (static_cast<uint64_t>(m_channels) * 2ULL);
        m_container = ContainerType::Dff;
        return true;
    }

    void SeekToCarrierFrame(uint64_t targetFrame) {
        if (targetFrame >= m_totalCarrierFrames) {
            m_framesRead = m_totalCarrierFrames;
            return;
        }
        if (m_container == ContainerType::Dff) {
            const uint64_t byteOffset = targetFrame * static_cast<uint64_t>(m_channels) * 2ULL;
            _fseeki64(m_fp, m_dataStartOffset + static_cast<__int64>(byteOffset), SEEK_SET);
            m_framesRead = targetFrame;
            m_octetsRead = targetFrame * 2ULL;
            m_carrierFrameIndex = targetFrame & 1ULL;
        } else if (m_container == ContainerType::Dsf) {
            const uint64_t bytesPerCh = targetFrame * 2ULL;
            const uint64_t blockIndex = bytesPerCh / m_dsfBlockSize;
            const uint32_t intraByte = static_cast<uint32_t>(bytesPerCh % m_dsfBlockSize);
            const uint64_t blockStride = static_cast<uint64_t>(m_dsfBlockSize) * m_channels;
            _fseeki64(m_fp, m_dataStartOffset + static_cast<__int64>(blockIndex * blockStride), SEEK_SET);
            if (EnsureDsfBlock()) {
                std::fill(m_dsfChBytePos.begin(), m_dsfChBytePos.end(), intraByte);
            }
            m_framesRead = targetFrame;
            m_octetsRead = targetFrame * 2ULL;
            m_carrierFrameIndex = targetFrame & 1ULL;
        }
    }

    FILE* m_fp = nullptr;
    ContainerType m_container = ContainerType::None;
    std::string m_dsdLabel;
    uint32_t m_dsdSampleRate = 0;
    uint32_t m_carrierRate = 0;
    uint16_t m_channels = 0;
    uint32_t m_dsfBlockSize = 4096;
    bool m_lsbFirst = true;
    __int64 m_dataStartOffset = 0;
    uint64_t m_dffDataBytes = 0;
    uint64_t m_totalCarrierFrames = 0;
    uint64_t m_framesRead = 0;
    uint64_t m_octetsRead = 0;
    uint64_t m_carrierFrameIndex = 0;
    std::vector<uint8_t> m_dsfBlockBuf;
    std::vector<uint32_t> m_dsfChBytePos;
    std::vector<uint8_t> m_dffScratch;
};

void WriteDopFrames(
    BYTE* pOut,
    const int32_t* pIn,
    uint32_t frames,
    uint32_t channels,
    WireSampleFormat wireFmt,
    float* fftRing,
    size_t& fftWritePos,
    TelemetryFrameStats& stats) {
    for (uint32_t f = 0; f < frames; ++f) {
        double mono = 0.0;
        for (uint32_t ch = 0; ch < channels; ++ch) {
            const size_t i = static_cast<size_t>(f) * channels + ch;
            const uint32_t word24 = static_cast<uint32_t>(pIn[i]) & 0x00FFFFFFu;

            // Bit-exact DoP v1.1 wire output (ZERO volume attenuation or DSP!)
            switch (wireFmt) {
                case WireSampleFormat::Pcm32:
                case WireSampleFormat::Pcm24In32: {
                    uint32_t* uOut = reinterpret_cast<uint32_t*>(pOut);
                    uOut[i] = (word24 << 8);
                    break;
                }
                case WireSampleFormat::Pcm24Packed: {
                    BYTE* b = pOut + i * 3;
                    b[0] = static_cast<BYTE>(word24 & 0xFFu);
                    b[1] = static_cast<BYTE>((word24 >> 8) & 0xFFu);
                    b[2] = static_cast<BYTE>((word24 >> 16) & 0xFFu);
                    break;
                }
                case WireSampleFormat::Float32:
                case WireSampleFormat::Pcm16:
                    break;
            }

            // Read-only 1-bit PDM popcount demodulation strictly for live UI visualizer/VU
            const uint8_t b0 = static_cast<uint8_t>((word24 >> 8) & 0xFFu);
            const uint8_t b1 = static_cast<uint8_t>(word24 & 0xFFu);
            const int ones = POPCOUNT_LUT[b0] + POPCOUNT_LUT[b1];
            const double normalized = (static_cast<double>(ones) - 8.0) / 8.0;
            const float absVal = static_cast<float>(std::fabs(normalized));
            mono += normalized;

            if (ch == 0) {
                if (absVal > stats.lPeak) stats.lPeak = absVal;
                stats.lSumSq += normalized * normalized;
                if (channels == 1) {
                    if (absVal > stats.rPeak) stats.rPeak = absVal;
                    stats.rSumSq += normalized * normalized;
                }
            } else if (ch == 1) {
                if (absVal > stats.rPeak) stats.rPeak = absVal;
                stats.rSumSq += normalized * normalized;
            }
        }
        fftRing[fftWritePos] = static_cast<float>(mono / static_cast<double>(channels > 0 ? channels : 1));
        fftWritePos = (fftWritePos + 1) % FFT_N;
    }
    stats.frameCount += frames;
}

int RunDopSelfTest(const std::string& path) {
    DopStreamReader reader;
    std::string err;
    if (!reader.Open(path, 0.0, err)) {
        EmitJsonLine("{\"ok\":false,\"error\":\"" + EscapeJson(err) + "\"}");
        return 11;
    }
    const size_t probeFrames = 4;
    std::vector<int32_t> words(probeFrames * reader.Channels(), 0);
    const size_t gotFrames = reader.ReadCarrierFrames(words.data(), probeFrames);

    std::string json = "{\"ok\":true,\"format\":\"" + reader.FormatName() +
        "\",\"dsdRate\":\"" + reader.DsdLabel() +
        "\",\"dsdSampleRate\":" + std::to_string(reader.DsdSampleRate()) +
        ",\"carrierRate\":" + std::to_string(reader.CarrierRate()) +
        ",\"channels\":" + std::to_string(reader.Channels()) +
        ",\"sampleFrames\":" + std::to_string(reader.TotalCarrierFrames()) +
        ",\"firstWords\":[";
    const size_t totalWords = gotFrames * reader.Channels();
    for (size_t i = 0; i < totalWords; ++i) {
        if (i > 0) json += ",";
        json += std::to_string(static_cast<uint32_t>(words[i]) & 0x00FFFFFFu);
    }
    json += "]}";
    EmitJsonLine(json);
    return 0;
}

struct OutputStreamSpec {
    uint32_t sampleRate = 48000;
    uint16_t channels = DEFAULT_CHANNELS;
    bool exclusive = true;
    bool isDop = false;
    bool usePushMode = false;
    bool useAsio = false;
    bool isRawDsd = false;
    uint32_t bufferMs = 0;
    uint32_t preRollMs = 0;
    std::string deviceId;
    std::string asioDriver;
    std::string dsdLabel;
};

struct OutputOpenResult {
    bool ok = false;
    bool activeExclusive = false;
    bool usePushMode = false;
    bool isAsio = false;
    bool isRawDsd = false;
    bool dsdMsbFirst = true;
    bool dopUnsupported = false;
    int errorExitCode = 1;
    WireSampleFormat wireFmt = WireSampleFormat::Pcm32;
    WAVEFORMATEXTENSIBLE chosenWfx{};
    uint32_t bufferFrameCount = 0;
    std::string deviceName;
    std::string dopRejectReason;
    std::string errorHresult;
    std::string errorMessage;
};

class IAudioOutputBackend {
public:
    virtual ~IAudioOutputBackend() = default;
    virtual OutputOpenResult Open(const OutputStreamSpec& spec) = 0;
    virtual bool PreFillSilence(uint32_t frames, uint32_t blockAlign) = 0;
    virtual bool Start(std::string& outHresult) = 0;
    virtual void Stop() = 0;
    virtual bool WaitNextBuffer(uint32_t timeoutMs, uint32_t& outFramesToWrite, bool& outTimedOut) = 0;
    virtual bool AcquireBuffer(uint32_t framesToWrite, BYTE** ppData) = 0;
    virtual void ReleaseBuffer(uint32_t framesWritten, DWORD flags) = 0;
    virtual HRESULT LastAcquireHResult() const { return S_OK; }
    virtual void Close() = 0;
};

class WasapiOutputBackend final : public IAudioOutputBackend {
public:
    ~WasapiOutputBackend() override {
        Close();
    }

    OutputOpenResult Open(const OutputStreamSpec& spec) override {
        Close();
        OutputOpenResult res{};

        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(hr)) {
            res.errorExitCode = 1;
            res.errorHresult = FormatHResult(hr);
            res.errorMessage = "CoInitializeEx failed";
            return res;
        }
        m_comInitialized = true;

        hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&m_enum));
        if (FAILED(hr) || !m_enum) {
            res.errorExitCode = 2;
            res.errorHresult = FormatHResult(hr);
            res.errorMessage = "MMDeviceEnumerator creation failed";
            Close();
            return res;
        }

        if (!spec.deviceId.empty()) {
            const std::wstring wid = Utf8ToWide(spec.deviceId);
            hr = m_enum->GetDevice(wid.c_str(), &m_device);
            if (FAILED(hr) || !m_device) {
                hr = m_enum->GetDefaultAudioEndpoint(eRender, eConsole, &m_device);
            }
        } else {
            hr = m_enum->GetDefaultAudioEndpoint(eRender, eConsole, &m_device);
        }

        if (FAILED(hr) || !m_device) {
            res.errorExitCode = 3;
            res.errorHresult = FormatHResult(hr);
            res.errorMessage = "No active audio output device found";
            Close();
            return res;
        }

        res.deviceName = ReadDeviceFriendlyName(m_device);

        hr = m_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&m_audioClient));
        if (FAILED(hr) || !m_audioClient) {
            res.errorExitCode = 4;
            res.errorHresult = FormatHResult(hr);
            res.errorMessage = "IAudioClient activation failed";
            Close();
            return res;
        }

        m_usePushMode = spec.usePushMode;
        res.usePushMode = spec.usePushMode;

        if (spec.exclusive) {
            struct CandidateFmt {
                uint16_t containerBits;
                uint16_t validBits;
                bool isFloat;
                WireSampleFormat wireFmt;
                bool allowedForDop;
            };
            const CandidateFmt dopFirstCandidates[] = {
                {32, 24, false, WireSampleFormat::Pcm24In32, true},
                {24, 24, false, WireSampleFormat::Pcm24Packed, true},
                {32, 32, false, WireSampleFormat::Pcm32, true}
            };
            const CandidateFmt pcmCandidates[] = {
                {32, 32, false, WireSampleFormat::Pcm32, true},
                {32, 24, false, WireSampleFormat::Pcm24In32, true},
                {24, 24, false, WireSampleFormat::Pcm24Packed, true},
                {32, 32, true,  WireSampleFormat::Float32, false},
                {16, 16, false, WireSampleFormat::Pcm16, false}
            };
            const CandidateFmt* candPtr = spec.isDop ? dopFirstCandidates : pcmCandidates;
            const size_t candCount = spec.isDop ? (sizeof(dopFirstCandidates) / sizeof(dopFirstCandidates[0]))
                                                : (sizeof(pcmCandidates) / sizeof(pcmCandidates[0]));

            for (size_t ci = 0; ci < candCount; ++ci) {
                const auto& c = candPtr[ci];
                if (spec.isDop && !c.allowedForDop) continue;
                WAVEFORMATEXTENSIBLE testWfx = BuildFormat(spec.sampleRate, spec.channels, c.containerBits, c.validBits, c.isFloat);
                hr = m_audioClient->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, reinterpret_cast<WAVEFORMATEX*>(&testWfx), nullptr);
                if (hr == S_OK) {
                    REFERENCE_TIME defPeriod = 0;
                    REFERENCE_TIME minPeriod = 0;
                    m_audioClient->GetDevicePeriod(&defPeriod, &minPeriod);
                    const REFERENCE_TIME basePeriod = (defPeriod > 0) ? defPeriod : 100000;
                    const REFERENCE_TIME minFloor = (minPeriod > 0) ? minPeriod : 30000;
                    const REFERENCE_TIME hnsBuf = (spec.bufferMs > 0)
                        ? std::max(minFloor, static_cast<REFERENCE_TIME>(spec.bufferMs) * 10000LL)
                        : basePeriod;
                    const DWORD exclFlags = spec.usePushMode ? 0u : AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
                    const REFERENCE_TIME exclPeriod = spec.usePushMode ? 0LL : hnsBuf;

                    hr = m_audioClient->Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        exclFlags,
                        hnsBuf,
                        exclPeriod,
                        reinterpret_cast<WAVEFORMATEX*>(&testWfx),
                        nullptr
                    );

                    // Per Microsoft Docs: handle AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED by querying GetBufferSize and re-initializing
                    if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
                        UINT32 alignedFrames = 0;
                        if (SUCCEEDED(m_audioClient->GetBufferSize(&alignedFrames)) && alignedFrames > 0) {
                            const REFERENCE_TIME alignedPeriod = static_cast<REFERENCE_TIME>(
                                (10000.0 * 1000.0 / static_cast<double>(spec.sampleRate) * static_cast<double>(alignedFrames)) + 0.5
                            );
                            m_audioClient->Release();
                            m_audioClient = nullptr;
                            hr = m_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&m_audioClient));
                            if (SUCCEEDED(hr) && m_audioClient) {
                                hr = m_audioClient->Initialize(
                                    AUDCLNT_SHAREMODE_EXCLUSIVE,
                                    exclFlags,
                                    alignedPeriod,
                                    spec.usePushMode ? 0LL : alignedPeriod,
                                    reinterpret_cast<WAVEFORMATEX*>(&testWfx),
                                    nullptr
                                );
                            }
                        }
                    }

                    if (SUCCEEDED(hr)) {
                        m_activeExclusive = true;
                        res.activeExclusive = true;
                        res.wireFmt = c.wireFmt;
                        res.chosenWfx = testWfx;
                        break;
                    }
                    if (m_audioClient) {
                        m_audioClient->Release();
                        m_audioClient = nullptr;
                        m_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&m_audioClient));
                    }
                }
            }
        }

        // Strict DoP gate: never downgrade DoP bitstreams into WASAPI Shared mixer or float resampling
        if (spec.isDop && !m_activeExclusive) {
            res.dopUnsupported = true;
            res.errorExitCode = 10;
            res.dopRejectReason = "DAC rejected bit-exact integer DoP carrier (" +
                spec.dsdLabel + " @ " + std::to_string(spec.sampleRate) + "Hz) in WASAPI Exclusive mode";
            Close();
            return res;
        }

        // Fallback cleanly to WASAPI Shared Mode with AUTOCONVERTPCM if Exclusive was not requested or hardware rejected exclusive access
        if (!m_activeExclusive) {
            if (!m_audioClient) {
                hr = m_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&m_audioClient));
            }
            if (FAILED(hr) || !m_audioClient) {
                res.errorExitCode = 5;
                res.errorHresult = FormatHResult(hr);
                res.errorMessage = "IAudioClient activation failed for Shared fallback";
                Close();
                return res;
            }
            res.chosenWfx = BuildFormat(spec.sampleRate, spec.channels, 32, 32, true);
            res.wireFmt = WireSampleFormat::Float32;

            REFERENCE_TIME defPeriod = 0;
            REFERENCE_TIME minPeriod = 0;
            m_audioClient->GetDevicePeriod(&defPeriod, &minPeriod);
            const REFERENCE_TIME basePeriod = (defPeriod > 0) ? defPeriod : 100000;
            const REFERENCE_TIME sharedBuf = (spec.bufferMs > 0)
                ? std::max(basePeriod * 2, static_cast<REFERENCE_TIME>(spec.bufferMs) * 10000LL)
                : basePeriod * 4;
            const DWORD sharedFlags = (spec.usePushMode ? 0u : AUDCLNT_STREAMFLAGS_EVENTCALLBACK) |
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

            hr = m_audioClient->Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                sharedFlags,
                sharedBuf,
                0,
                reinterpret_cast<WAVEFORMATEX*>(&res.chosenWfx),
                nullptr
            );

            if (FAILED(hr)) {
                res.errorExitCode = 5;
                res.errorHresult = FormatHResult(hr);
                res.errorMessage = "IAudioClient::Initialize failed in both Exclusive and Shared mode";
                Close();
                return res;
            }
        }

        hr = m_audioClient->GetBufferSize(&m_bufferFrameCount);
        if (FAILED(hr) || m_bufferFrameCount == 0) {
            res.errorExitCode = 6;
            res.errorHresult = FormatHResult(hr);
            res.errorMessage = "GetBufferSize failed";
            Close();
            return res;
        }
        res.bufferFrameCount = m_bufferFrameCount;
        m_sampleRate = spec.sampleRate > 0 ? spec.sampleRate : 48000;
        const uint64_t totalBufMs = (static_cast<uint64_t>(m_bufferFrameCount) * 1000ULL) / m_sampleRate;
        m_pushPollMs = static_cast<uint32_t>(std::max<uint64_t>(1ULL, std::min<uint64_t>(8ULL, totalBufMs / 3ULL)));

        if (!m_usePushMode) {
            m_audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            if (m_audioEvent) {
                hr = m_audioClient->SetEventHandle(m_audioEvent);
            }
            if (!m_audioEvent || FAILED(hr)) {
                res.errorExitCode = 7;
                res.errorHresult = FormatHResult(hr);
                res.errorMessage = "SetEventHandle failed";
                Close();
                return res;
            }
        }

        hr = m_audioClient->GetService(IID_PPV_ARGS(&m_renderClient));
        if (FAILED(hr) || !m_renderClient) {
            res.errorExitCode = 8;
            res.errorHresult = FormatHResult(hr);
            res.errorMessage = "GetService(IAudioRenderClient) failed";
            Close();
            return res;
        }

        res.ok = true;
        return res;
    }

    bool PreFillSilence(uint32_t frames, uint32_t blockAlign) override {
        BYTE* pInitData = nullptr;
        if (m_renderClient && SUCCEEDED(m_renderClient->GetBuffer(frames, &pInitData)) && pInitData) {
            std::memset(pInitData, 0, static_cast<size_t>(frames) * blockAlign);
            m_renderClient->ReleaseBuffer(frames, AUDCLNT_BUFFERFLAGS_SILENT);
            return true;
        }
        return false;
    }

    bool Start(std::string& outHresult) override {
        if (!m_audioClient) {
            outHresult = FormatHResult(E_POINTER);
            return false;
        }
        const HRESULT hr = m_audioClient->Start();
        if (FAILED(hr)) {
            outHresult = FormatHResult(hr);
            return false;
        }
        return true;
    }

    void Stop() override {
        if (m_audioClient) {
            m_audioClient->Stop();
        }
    }

    bool WaitNextBuffer(uint32_t timeoutMs, uint32_t& outFramesToWrite, bool& outTimedOut) override {
        outFramesToWrite = 0;
        outTimedOut = false;
        if (m_usePushMode) {
            if (!m_audioClient) return false;
            const ULONGLONG deadline = GetTickCount64() + timeoutMs;
            const UINT32 minFree = std::max<UINT32>(1u, m_bufferFrameCount / 4u);
            while (true) {
                UINT32 padding = 0;
                const HRESULT hr = m_audioClient->GetCurrentPadding(&padding);
                if (FAILED(hr)) return false;
                const UINT32 freeFrames = (padding < m_bufferFrameCount) ? (m_bufferFrameCount - padding) : 0u;
                if (freeFrames >= minFree) {
                    outFramesToWrite = freeFrames;
                    return true;
                }
                if (GetTickCount64() >= deadline) {
                    outTimedOut = true;
                    return true;
                }
                Sleep(m_pushPollMs);
            }
        }

        if (!m_audioEvent) return false;
        const DWORD waitRes = WaitForSingleObject(m_audioEvent, timeoutMs);
        if (waitRes != WAIT_OBJECT_0) {
            outTimedOut = true;
            return true;
        }
        UINT32 framesToWrite = m_bufferFrameCount;
        if (!m_activeExclusive && m_audioClient) {
            UINT32 padding = 0;
            if (SUCCEEDED(m_audioClient->GetCurrentPadding(&padding))) {
                if (padding >= m_bufferFrameCount) {
                    outFramesToWrite = 0;
                    return true;
                }
                framesToWrite = m_bufferFrameCount - padding;
            }
        }
        outFramesToWrite = framesToWrite;
        return true;
    }

    bool AcquireBuffer(uint32_t framesToWrite, BYTE** ppData) override {
        if (!m_renderClient || !ppData) return false;
        *ppData = nullptr;
        m_lastAcquireHr = m_renderClient->GetBuffer(framesToWrite, ppData);
        return SUCCEEDED(m_lastAcquireHr) && *ppData != nullptr;
    }

    void ReleaseBuffer(uint32_t framesWritten, DWORD flags) override {
        if (m_renderClient) {
            m_renderClient->ReleaseBuffer(framesWritten, flags);
        }
    }

    HRESULT LastAcquireHResult() const override {
        return m_lastAcquireHr;
    }

    void Close() override {
        if (m_audioEvent) {
            CloseHandle(m_audioEvent);
            m_audioEvent = nullptr;
        }
        if (m_renderClient) {
            m_renderClient->Release();
            m_renderClient = nullptr;
        }
        if (m_audioClient) {
            m_audioClient->Release();
            m_audioClient = nullptr;
        }
        if (m_device) {
            m_device->Release();
            m_device = nullptr;
        }
        if (m_enum) {
            m_enum->Release();
            m_enum = nullptr;
        }
        if (m_comInitialized) {
            CoUninitialize();
            m_comInitialized = false;
        }
        m_activeExclusive = false;
        m_usePushMode = false;
        m_bufferFrameCount = 0;
        m_lastAcquireHr = S_OK;
    }

private:
    bool m_comInitialized = false;
    bool m_activeExclusive = false;
    bool m_usePushMode = false;
    uint32_t m_bufferFrameCount = 0;
    uint32_t m_sampleRate = 48000;
    uint32_t m_pushPollMs = 2;
    HRESULT m_lastAcquireHr = S_OK;
    IMMDeviceEnumerator* m_enum = nullptr;
    IMMDevice* m_device = nullptr;
    IAudioClient* m_audioClient = nullptr;
    IAudioRenderClient* m_renderClient = nullptr;
    HANDLE m_audioEvent = nullptr;
};

class AsioOutputBackend final : public IAudioOutputBackend {
public:
    ~AsioOutputBackend() override {
        Close();
    }

    OutputOpenResult Open(const OutputStreamSpec& spec) override {
        Close();
        OutputOpenResult res{};
        vanta_asio::AsioOpenConfig cfg{};
        cfg.driverName = spec.asioDriver;
        cfg.sampleRate = spec.sampleRate;
        cfg.channels = spec.channels;
        cfg.rawDsd = spec.isRawDsd;
        if (spec.bufferMs > 0 && spec.sampleRate > 0) {
            cfg.preferredBufferFrames = static_cast<uint32_t>((static_cast<uint64_t>(spec.sampleRate) * spec.bufferMs) / 1000ULL);
        }

        const vanta_asio::AsioSessionOutcome outcome = m_host.Open(cfg);
        if (!outcome.ok) {
            res.errorExitCode = 11;
            res.errorHresult = "ASIO_ERR";
            res.errorMessage = outcome.errorMessage;
            return res;
        }

        m_isRawDsd = outcome.rawDsdActive;
        m_channels = outcome.channels;
        m_sampleType = outcome.sampleType;
        m_unitCount = m_isRawDsd ? std::max<uint32_t>(1u, outcome.bufferFrames / 8u) : outcome.bufferFrames;

        if (m_isRawDsd) {
            m_unitBytes = m_channels; // 1 DSD octet per channel per unit
            res.wireFmt = WireSampleFormat::Pcm32;
            res.chosenWfx = BuildFormat(spec.sampleRate / 8u, m_channels, 8, 8, false);
            res.chosenWfx.Format.nBlockAlign = static_cast<WORD>(m_channels);
        } else {
            uint16_t containerBits = 32;
            uint16_t validBits = 32;
            bool isFloat = false;
            switch (m_sampleType) {
                case vanta_asio::kStInt16Lsb:
                    containerBits = 16; validBits = 16; res.wireFmt = WireSampleFormat::Pcm16; break;
                case vanta_asio::kStInt24Lsb:
                    containerBits = 24; validBits = 24; res.wireFmt = WireSampleFormat::Pcm24Packed; break;
                case vanta_asio::kStFloat32Lsb:
                    containerBits = 32; validBits = 32; isFloat = true; res.wireFmt = WireSampleFormat::Float32; break;
                case vanta_asio::kStFloat64Lsb:
                    containerBits = 64; validBits = 64; isFloat = true; res.wireFmt = WireSampleFormat::Float32; break;
                case vanta_asio::kStInt32Lsb24:
                    containerBits = 32; validBits = 24; res.wireFmt = WireSampleFormat::Pcm32; break;
                default:
                    containerBits = 32; validBits = 32; res.wireFmt = WireSampleFormat::Pcm32; break;
            }
            res.chosenWfx = BuildFormat(outcome.sampleRate, m_channels, (containerBits == 64 ? 32 : containerBits), (validBits == 64 ? 32 : validBits), isFloat);
            m_unitBytes = (m_sampleType == vanta_asio::kStFloat64Lsb) ? (static_cast<size_t>(m_channels) * 8u) : res.chosenWfx.Format.nBlockAlign;
        }

        m_staging.assign(static_cast<size_t>(m_unitCount) * m_unitBytes, 0);
        m_stagingFloatTmp.assign(static_cast<size_t>(m_unitCount) * m_channels, 0.0f);

        res.ok = true;
        res.activeExclusive = true;
        res.usePushMode = false;
        res.isAsio = true;
        res.isRawDsd = m_isRawDsd;
        res.dsdMsbFirst = outcome.dsdMsbFirst;
        res.bufferFrameCount = m_unitCount;
        res.deviceName = outcome.driverName + (m_isRawDsd ? " [ASIO Raw DSD]" : " [ASIO]");
        return res;
    }

    bool PreFillSilence(uint32_t /*frames*/, uint32_t /*blockAlign*/) override {
        return true;
    }

    bool Start(std::string& outHresult) override {
        if (!m_host.Start()) {
            outHresult = "ASIO_START_FAIL";
            return false;
        }
        return true;
    }

    void Stop() override {
        m_host.Stop();
    }

    bool WaitNextBuffer(uint32_t timeoutMs, uint32_t& outFramesToWrite, bool& outTimedOut) override {
        return m_host.WaitNextSwitch(timeoutMs, outFramesToWrite, outTimedOut);
    }

    bool AcquireBuffer(uint32_t framesToWrite, BYTE** ppData) override {
        if (!ppData || framesToWrite == 0 || framesToWrite > m_unitCount) return false;
        if (!m_isRawDsd && m_sampleType == vanta_asio::kStFloat64Lsb) {
            std::fill(m_stagingFloatTmp.begin(), m_stagingFloatTmp.end(), 0.0f);
            *ppData = reinterpret_cast<BYTE*>(m_stagingFloatTmp.data());
            return true;
        }
        if (m_isRawDsd) vanta_asio::AsioDriverHost::FillRawDsdSilence(m_staging.data(), m_staging.size());
        else std::fill(m_staging.begin(), m_staging.end(), BYTE{0});
        *ppData = m_staging.data();
        return true;
    }

    void ReleaseBuffer(uint32_t framesWritten, DWORD flags) override {
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || framesWritten == 0;
        if (!silent && !m_isRawDsd && m_sampleType == vanta_asio::kStFloat64Lsb) {
            auto* dOut = reinterpret_cast<double*>(m_staging.data());
            const size_t n = static_cast<size_t>(std::min(framesWritten, m_unitCount)) * m_channels;
            for (size_t i = 0; i < n; ++i) {
                dOut[i] = static_cast<double>(m_stagingFloatTmp[i]);
            }
        }
        m_host.PublishChannelData(m_staging, silent);
    }

    void Close() override {
        m_host.Close();
        m_unitCount = 0;
    }

private:
    vanta_asio::AsioDriverHost m_host;
    bool m_isRawDsd = false;
    uint16_t m_channels = 2;
    uint32_t m_unitCount = 0;
    size_t m_unitBytes = 8;
    vanta_asio::AsioSampleType m_sampleType = vanta_asio::kStInt32Lsb;
    std::vector<BYTE> m_staging;
    std::vector<float> m_stagingFloatTmp;
};

class MemoryTestSinkBackend final : public IAudioOutputBackend {
public:
    MemoryTestSinkBackend(WireSampleFormat fmt, uint32_t bufferFrames, std::string deviceName = "VANTA Memory Test Sink")
        : m_wireFmt(fmt), m_bufferFrames(bufferFrames > 0 ? bufferFrames : 256), m_deviceName(std::move(deviceName)) {}

    OutputOpenResult Open(const OutputStreamSpec& spec) override {
        OutputOpenResult res{};
        uint16_t containerBits = 32;
        uint16_t validBits = 32;
        bool isFloat = false;
        switch (m_wireFmt) {
            case WireSampleFormat::Pcm16:
                containerBits = 16; validBits = 16; break;
            case WireSampleFormat::Pcm24Packed:
                containerBits = 24; validBits = 24; break;
            case WireSampleFormat::Pcm24In32:
                containerBits = 32; validBits = 24; break;
            case WireSampleFormat::Pcm32:
                containerBits = 32; validBits = 32; break;
            case WireSampleFormat::Float32:
                containerBits = 32; validBits = 32; isFloat = true; break;
        }
        m_chosenWfx = BuildFormat(spec.sampleRate, spec.channels, containerBits, validBits, isFloat);
        m_staging.assign(static_cast<size_t>(m_bufferFrames) * m_chosenWfx.Format.nBlockAlign, 0);
        m_capturedBytes.clear();
        m_preFillCount = 0;
        m_audioReleaseCount = 0;
        m_silentReleaseCount = 0;
        m_opened = true;
        m_started = false;
        m_closed = false;

        res.ok = true;
        res.activeExclusive = spec.exclusive;
        res.usePushMode = spec.usePushMode;
        res.wireFmt = m_wireFmt;
        res.chosenWfx = m_chosenWfx;
        res.bufferFrameCount = m_bufferFrames;
        res.deviceName = m_deviceName;
        return res;
    }

    bool PreFillSilence(uint32_t frames, uint32_t blockAlign) override {
        if (!m_opened || frames > m_bufferFrames) return false;
        ++m_preFillCount;
        m_capturedBytes.insert(m_capturedBytes.end(), static_cast<size_t>(frames) * blockAlign, 0);
        return true;
    }

    bool Start(std::string& /*outHresult*/) override {
        if (!m_opened) return false;
        m_started = true;
        return true;
    }

    void Stop() override {
        m_started = false;
    }

    bool WaitNextBuffer(uint32_t /*timeoutMs*/, uint32_t& outFramesToWrite, bool& outTimedOut) override {
        outTimedOut = false;
        outFramesToWrite = m_started ? m_bufferFrames : 0;
        return m_started;
    }

    bool AcquireBuffer(uint32_t framesToWrite, BYTE** ppData) override {
        if (!m_opened || !ppData || framesToWrite > m_bufferFrames) return false;
        std::fill(m_staging.begin(), m_staging.end(), BYTE{0});
        *ppData = m_staging.data();
        return true;
    }

    void ReleaseBuffer(uint32_t framesWritten, DWORD flags) override {
        const size_t bytes = static_cast<size_t>(framesWritten) * m_chosenWfx.Format.nBlockAlign;
        if (bytes > m_staging.size()) return;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
            ++m_silentReleaseCount;
            m_capturedBytes.insert(m_capturedBytes.end(), bytes, 0);
        } else {
            ++m_audioReleaseCount;
            m_capturedBytes.insert(m_capturedBytes.end(), m_staging.begin(), m_staging.begin() + bytes);
        }
    }

    void Close() override {
        m_started = false;
        m_opened = false;
        m_closed = true;
    }

    const std::vector<uint8_t>& CapturedBytes() const { return m_capturedBytes; }
    uint32_t PreFillCount() const { return m_preFillCount; }
    uint32_t AudioReleaseCount() const { return m_audioReleaseCount; }
    uint32_t SilentReleaseCount() const { return m_silentReleaseCount; }
    bool IsClosed() const { return m_closed; }

private:
    WireSampleFormat m_wireFmt;
    uint32_t m_bufferFrames;
    std::string m_deviceName;
    WAVEFORMATEXTENSIBLE m_chosenWfx{};
    std::vector<BYTE> m_staging;
    std::vector<uint8_t> m_capturedBytes;
    uint32_t m_preFillCount = 0;
    uint32_t m_audioReleaseCount = 0;
    uint32_t m_silentReleaseCount = 0;
    bool m_opened = false;
    bool m_started = false;
    bool m_closed = false;
};

uint64_t Fnv1a64(const void* data, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    uint64_t h = 14695981039346656037ULL;
    for (size_t i = 0; i < len; ++i) {
        h ^= p[i];
        h *= 1099511628211ULL;
    }
    return h;
}

int RunSelfTest() {
    bool okRing = false;
    bool okBitExact32 = false;
    bool okBitExact24 = false;
    bool okPurePathUnity = false;
    bool okPurePathEq = false;
    bool okTruePeakInterSample = false;
    bool okTpdf16 = false;
    bool okDopMarkers = false;
    bool okBackendLifecycle = false;

    // 1. PcmRingBuffer wrap-around integrity
    {
        PcmRingBuffer rb(1024, 2);
        std::vector<int32_t> src(5000 * 2);
        for (size_t i = 0; i < src.size(); ++i) {
            src[i] = static_cast<int32_t>((static_cast<int64_t>(i) * 1315423911LL) & 0x7FFFFFFFLL) - 0x3FFFFFFF;
        }
        std::vector<int32_t> dst;
        dst.reserve(src.size());
        size_t wOff = 0;
        while (wOff < 5000) {
            const size_t chunk = std::min<size_t>(333, 5000 - wOff);
            const size_t wrote = rb.Write(src.data() + wOff * 2, chunk);
            wOff += wrote;
            std::vector<int32_t> tmp(257 * 2);
            while (rb.AvailableToRead() > 0) {
                const size_t got = rb.Read(tmp.data(), 257);
                if (got == 0) break;
                dst.insert(dst.end(), tmp.begin(), tmp.begin() + got * 2);
            }
        }
        okRing = (dst.size() == src.size()) && (std::memcmp(dst.data(), src.data(), src.size() * sizeof(int32_t)) == 0) && (rb.AvailableToRead() == 0);
    }

    // 2. Bit-Exact Pcm32 passthrough through MemoryTestSinkBackend + ConvertAndWriteFrames
    {
        const uint32_t frames = 512;
        const uint32_t ch = 2;
        std::vector<int32_t> inPcm(frames * ch);
        for (uint32_t i = 0; i < frames * ch; ++i) {
            inPcm[i] = static_cast<int32_t>(static_cast<uint32_t>((i * 2654435761u) ^ 0xA5A55A00u));
        }
        MemoryTestSinkBackend sink(WireSampleFormat::Pcm32, frames);
        OutputStreamSpec spec{};
        spec.sampleRate = 96000;
        spec.channels = 2;
        spec.exclusive = true;
        const OutputOpenResult openRes = sink.Open(spec);
        std::string hr;
        const bool started = openRes.ok && sink.Start(hr);
        uint32_t ftw = 0;
        bool timedOut = false;
        BYTE* pOut = nullptr;
        if (started && sink.WaitNextBuffer(0, ftw, timedOut) && ftw == frames && sink.AcquireBuffer(ftw, &pOut)) {
            PurePathDspRack64 rack;
            rack.ApplyConfig(96000, DspConfigSnapshot{});
            TruePeakLimiter64 lim;
            lim.Configure(96000, -0.3);
            TpdfDitherShaper64 dither;
            float fftRing[FFT_N] = {};
            size_t fftPos = 0;
            TelemetryFrameStats stats{};
            ConvertAndWriteFrames(pOut, inPcm.data(), ftw, ch, openRes.wireFmt, 1.0f, rack, lim, dither, fftRing, fftPos, stats);
            sink.ReleaseBuffer(ftw, 0);
            sink.Stop();
            sink.Close();
            const auto& outBytes = sink.CapturedBytes();
            const size_t expectedBytes = static_cast<size_t>(frames) * ch * sizeof(int32_t);
            okBitExact32 = (outBytes.size() == expectedBytes) &&
                (Fnv1a64(outBytes.data(), expectedBytes) == Fnv1a64(inPcm.data(), expectedBytes)) &&
                (std::memcmp(outBytes.data(), inPcm.data(), expectedBytes) == 0);
        }
    }

    // 3. Bit-Exact Pcm24Packed preserves top 24 bits identically
    {
        const uint32_t frames = 256;
        const uint32_t ch = 2;
        std::vector<int32_t> inPcm(frames * ch);
        for (uint32_t i = 0; i < frames * ch; ++i) {
            const int32_t s24 = static_cast<int32_t>((i * 1973u) % 16777216u) - 8388608;
            inPcm[i] = static_cast<int32_t>(static_cast<uint32_t>(s24) << 8);
        }
        MemoryTestSinkBackend sink(WireSampleFormat::Pcm24Packed, frames);
        OutputStreamSpec spec24{};
        spec24.sampleRate = 48000;
        spec24.channels = 2;
        spec24.exclusive = true;
        const OutputOpenResult openRes = sink.Open(spec24);
        std::string hr;
        BYTE* pOut = nullptr;
        uint32_t ftw = 0;
        bool timedOut = false;
        if (openRes.ok && sink.Start(hr) && sink.WaitNextBuffer(0, ftw, timedOut) && sink.AcquireBuffer(ftw, &pOut)) {
            PurePathDspRack64 rack;
            rack.ApplyConfig(48000, DspConfigSnapshot{});
            TruePeakLimiter64 lim;
            lim.Configure(48000, -0.3);
            TpdfDitherShaper64 dither;
            float fftRing[FFT_N] = {};
            size_t fftPos = 0;
            TelemetryFrameStats stats{};
            ConvertAndWriteFrames(pOut, inPcm.data(), ftw, ch, openRes.wireFmt, 1.0f, rack, lim, dither, fftRing, fftPos, stats);
            sink.ReleaseBuffer(ftw, 0);
            sink.Stop();
            sink.Close();
            const auto& outBytes = sink.CapturedBytes();
            bool match = outBytes.size() == static_cast<size_t>(frames) * ch * 3;
            for (size_t i = 0; match && i < inPcm.size(); ++i) {
                const uint32_t expected24 = (static_cast<uint32_t>(inPcm[i]) >> 8) & 0xFFFFFFu;
                const uint32_t got24 = static_cast<uint32_t>(outBytes[i * 3]) |
                    (static_cast<uint32_t>(outBytes[i * 3 + 1]) << 8) |
                    (static_cast<uint32_t>(outBytes[i * 3 + 2]) << 16);
                if (got24 != expected24) match = false;
            }
            okBitExact24 = match;
        }
    }

    // 4. PurePath 64 unity biquad precision (< 1e-14)
    {
        PurePathDspRack64 rack;
        rack.ApplyConfig(96000, DspConfigSnapshot{});
        double maxErr = 0.0;
        for (int i = 0; i < 1024; ++i) {
            const double orig = 0.5 * std::sin(2.0 * VANTA_PI * 1000.0 * i / 96000.0);
            double frame[2] = { orig, -orig };
            rack.ProcessFrame(frame, 2);
            maxErr = std::max(maxErr, std::fabs(frame[0] - orig));
            maxErr = std::max(maxErr, std::fabs(frame[1] + orig));
        }
        okPurePathUnity = (maxErr < 1e-14);
    }

    // 5. PurePath 64 +6 dB EQ + Sub-Bass with TruePeakLimiter64 bounds output <= -0.3 dBFS
    {
        const uint32_t frames = 2048;
        std::vector<int32_t> inPcm(frames * 2);
        for (uint32_t f = 0; f < frames; ++f) {
            const double v = 0.82 * std::sin(2.0 * VANTA_PI * 1000.0 * f / 48000.0);
            inPcm[f * 2] = static_cast<int32_t>(v * 2147483647.0);
            inPcm[f * 2 + 1] = inPcm[f * 2];
        }
        std::vector<float> outFloat(frames * 2, 0.0f);
        DspConfigSnapshot cfg{};
        cfg.bandGains[5] = 6.0;
        cfg.bass = true;
        cfg.bassDb = 5.5;
        cfg.limiter = true;
        PurePathDspRack64 rack;
        rack.ApplyConfig(48000, cfg);
        TruePeakLimiter64 lim;
        lim.Configure(48000, -0.3);
        TpdfDitherShaper64 dither;
        float fftRing[FFT_N] = {};
        size_t fftPos = 0;
        TelemetryFrameStats stats{};
        ConvertAndWriteFrames(reinterpret_cast<BYTE*>(outFloat.data()), inPcm.data(), frames, 2, WireSampleFormat::Float32, 1.0f, rack, lim, dither, fftRing, fftPos, stats);
        const double ceiling = std::pow(10.0, -0.3 / 20.0);
        float maxOut = 0.0f;
        for (float s : outFloat) {
            maxOut = std::max(maxOut, std::fabs(s));
        }
        okPurePathEq = (rack.preampGain < 1.0) && (maxOut > 0.2f) && (static_cast<double>(maxOut) <= ceiling + 1e-5);
    }

    // 6. TruePeakLimiter64 detects 4x Hermite inter-sample peak > 1.0 when samples themselves are < 0.96
    {
        TruePeakLimiter64 lim;
        lim.Configure(48000, -0.3);
        const double ceiling = std::pow(10.0, -0.3 / 20.0);
        const double seq[6] = { -0.95, 0.95, 0.95, -0.95, -0.95, 0.95 };
        bool attenuated = false;
        bool bounded = true;
        for (int i = 0; i < 6; ++i) {
            double frame[2] = { seq[i], seq[i] };
            lim.ProcessFrame(frame, 2);
            if (lim.envelopeGain < 0.999) attenuated = true;
            if (std::fabs(frame[0]) > ceiling + 1e-9) bounded = false;
        }
        okTruePeakInterSample = attenuated && bounded;
    }

    // 7. TpdfDitherShaper64 16-bit quantization has zero DC bias & finite noise
    {
        TpdfDitherShaper64 dither;
        const int n = 4096;
        double sumErr = 0.0;
        double sumSqErr = 0.0;
        for (int i = 0; i < n; ++i) {
            const double x = 0.0001 * std::sin(2.0 * VANTA_PI * 997.0 * i / 48000.0);
            const int16_t q = dither.Quantize16(x, 0);
            const double err = (static_cast<double>(q) / 32768.0) - x;
            sumErr += err;
            sumSqErr += err * err;
        }
        const double meanErr = std::fabs(sumErr / n);
        const double rmsErr = std::sqrt(sumSqErr / n);
        const double lsb = 1.0 / 32768.0;
        okTpdf16 = std::isfinite(meanErr) && std::isfinite(rmsErr) && (meanErr < 0.5 * lsb) && (rmsErr > 0.1 * lsb) && (rmsErr < 3.0 * lsb);
    }

    // 8. DoP v1.1 marker alternation (0x05 / 0xFA)
    {
        okDopMarkers =
            (PackDopWord24(0, 0xAB, 0xCD) == 0x05ABCDu) &&
            (PackDopWord24(1, 0xAB, 0xCD) == 0xFAABCDu) &&
            (PackDopWord24(2, 0x12, 0x34) == 0x051234u) &&
            (PackDopWord24(3, 0x12, 0x34) == 0xFA1234u);
    }

    // 9. MemoryTestSinkBackend full lifecycle (PreFillSilence + Start + Audio + Silent + Close)
    {
        MemoryTestSinkBackend sink(WireSampleFormat::Pcm24In32, 128);
        OutputStreamSpec spec9{};
        spec9.sampleRate = 44100;
        spec9.channels = 2;
        spec9.exclusive = true;
        const OutputOpenResult openRes = sink.Open(spec9);
        std::string hr;
        BYTE* pOut = nullptr;
        uint32_t ftw = 0;
        bool timedOut = false;
        bool ok = openRes.ok &&
            sink.PreFillSilence(128, openRes.chosenWfx.Format.nBlockAlign) &&
            sink.Start(hr) &&
            sink.WaitNextBuffer(0, ftw, timedOut) &&
            !timedOut && ftw == 128 &&
            sink.AcquireBuffer(ftw, &pOut);
        if (ok) {
            std::memset(pOut, 0x40, static_cast<size_t>(ftw) * openRes.chosenWfx.Format.nBlockAlign);
            sink.ReleaseBuffer(ftw, 0);
            sink.Stop();
            sink.Close();
            okBackendLifecycle =
                (sink.PreFillCount() == 1) &&
                (sink.AudioReleaseCount() == 1) &&
                (sink.CapturedBytes().size() == static_cast<size_t>(256) * openRes.chosenWfx.Format.nBlockAlign) &&
                sink.IsClosed();
        }
    }

    // 10. f64le +3.5 dBFS headroom preservation with -4 dB attenuation (0 clipped samples)
    bool okF64leHeadroom = false;
    {
        const uint32_t frames = 1024;
        std::vector<double> inF64(frames * 2);
        const double amp = std::pow(10.0, 3.5 / 20.0); // ~1.4962
        for (uint32_t f = 0; f < frames; ++f) {
            const double v = amp * std::sin(2.0 * VANTA_PI * 1000.0 * f / 44100.0);
            inF64[f * 2] = v;
            inF64[f * 2 + 1] = -v;
        }
        std::vector<float> outF32(frames * 2, 0.0f);
        DspConfigSnapshot cfg{};
        PurePathDspRack64 rack;
        rack.ApplyConfig(44100, cfg);
        TruePeakLimiter64 lim;
        lim.Configure(44100, -0.3);
        TpdfDitherShaper64 dither;
        float fftRing[FFT_N] = {};
        size_t fftPos = 0;
        TelemetryFrameStats stats{};
        const float attenGain = static_cast<float>(std::pow(10.0, -4.0 / 20.0));
        ConvertAndWriteFloatFrames(
            reinterpret_cast<BYTE*>(outF32.data()), inF64.data(), frames, 2,
            WireSampleFormat::Float32, attenGain, rack, lim, dither, fftRing, fftPos, stats, 32
        );
        float maxOut = 0.0f;
        for (float s : outF32) maxOut = std::max(maxOut, std::fabs(s));
        okF64leHeadroom = (maxOut > 0.88f && maxOut < 0.96f);
    }

    // 11. Smart 24->16 TPDF Dither vs 16->16 Bit-Exact passthrough
    bool okSmartDither24To16 = false;
    {
        const uint32_t frames = 512;
        std::vector<int32_t> in24(frames * 2);
        std::vector<int32_t> in16(frames * 2);
        for (uint32_t f = 0; f < frames; ++f) {
            // 24-bit sub-LSB sine (~0.35 LSB of 16-bit)
            const int32_t val24 = static_cast<int32_t>(std::llround(0.35 * 65536.0 * std::sin(2.0 * VANTA_PI * 700.0 * f / 48000.0)));
            in24[f * 2] = val24;
            in24[f * 2 + 1] = val24;
            const int16_t s16 = static_cast<int16_t>((f % 100) - 50);
            in16[f * 2] = static_cast<int32_t>(static_cast<uint32_t>(static_cast<uint16_t>(s16)) << 16);
            in16[f * 2 + 1] = in16[f * 2];
        }
        std::vector<int16_t> outFrom24(frames * 2, 0);
        std::vector<int16_t> outFrom16(frames * 2, 0);
        PurePathDspRack64 rack;
        rack.ApplyConfig(48000, DspConfigSnapshot{});
        TruePeakLimiter64 lim;
        lim.Configure(48000, -0.3);
        TpdfDitherShaper64 dither;
        float fftRing[FFT_N] = {};
        size_t fftPos = 0;
        TelemetryFrameStats stats{};
        ConvertAndWriteFrames(reinterpret_cast<BYTE*>(outFrom24.data()), in24.data(), frames, 2, WireSampleFormat::Pcm16, 1.0f, rack, lim, dither, fftRing, fftPos, stats, 24);
        ConvertAndWriteFrames(reinterpret_cast<BYTE*>(outFrom16.data()), in16.data(), frames, 2, WireSampleFormat::Pcm16, 1.0f, rack, lim, dither, fftRing, fftPos, stats, 16);

        bool hasDitheredNonZero = false;
        for (int16_t s : outFrom24) {
            if (s != 0) { hasDitheredNonZero = true; break; }
        }
        bool exact16 = true;
        for (size_t i = 0; i < frames * 2; ++i) {
            const int16_t expected = static_cast<int16_t>((static_cast<uint32_t>(in16[i]) >> 16) & 0xFFFFu);
            if (outFrom16[i] != expected) { exact16 = false; break; }
        }
        okSmartDither24To16 = hasDitheredNonZero && exact16;
    }

    // 12. Push mode lifecycle + 13. Cross-rate re-init (44.1 kHz -> 96 kHz + preRollMs)
    bool okPushMode = false;
    bool okCrossRateReinit = false;
    {
        MemoryTestSinkBackend sink(WireSampleFormat::Pcm32, 256);
        OutputStreamSpec specPush{};
        specPush.sampleRate = 44100;
        specPush.channels = 2;
        specPush.exclusive = true;
        specPush.usePushMode = true;
        specPush.bufferMs = 25;
        const OutputOpenResult open1 = sink.Open(specPush);
        std::string hr;
        BYTE* pOut = nullptr;
        uint32_t ftw = 0;
        bool timedOut = false;
        if (open1.ok && open1.usePushMode && sink.Start(hr) && sink.WaitNextBuffer(0, ftw, timedOut) && sink.AcquireBuffer(ftw, &pOut)) {
            sink.ReleaseBuffer(ftw, 0);
            sink.Stop();
            sink.Close();
            okPushMode = (sink.AudioReleaseCount() == 1);

            OutputStreamSpec spec96{};
            spec96.sampleRate = 96000;
            spec96.channels = 2;
            spec96.exclusive = true;
            spec96.preRollMs = 50;
            const OutputOpenResult open2 = sink.Open(spec96);
            if (open2.ok && sink.PreFillSilence(256, open2.chosenWfx.Format.nBlockAlign) && sink.Start(hr)) {
                const uint32_t preRollFrames = (96000u * 50u) / 1000u; // 4800 silent frames
                uint32_t writtenSilent = 0;
                while (writtenSilent < preRollFrames && sink.WaitNextBuffer(0, ftw, timedOut) && sink.AcquireBuffer(ftw, &pOut)) {
                    const uint32_t chunk = std::min(ftw, preRollFrames - writtenSilent);
                    std::memset(pOut, 0, static_cast<size_t>(chunk) * open2.chosenWfx.Format.nBlockAlign);
                    sink.ReleaseBuffer(chunk, AUDCLNT_BUFFERFLAGS_SILENT);
                    writtenSilent += chunk;
                }
                if (sink.WaitNextBuffer(0, ftw, timedOut) && sink.AcquireBuffer(ftw, &pOut)) {
                    std::memset(pOut, 0x22, static_cast<size_t>(ftw) * open2.chosenWfx.Format.nBlockAlign);
                    sink.ReleaseBuffer(ftw, 0);
                }
                sink.Stop();
                sink.Close();
                okCrossRateReinit = (writtenSilent == preRollFrames) && (sink.AudioReleaseCount() == 1) && (sink.SilentReleaseCount() > 0);
            }
        }
    }

    // 14. ASIO Registry Driver Enumeration + 15. DSD512 Raw Octet Bit-Order Conversion + 16. SACD ISO ScarletBook Parser
    bool okAsioEnum = false;
    bool okDsd512Raw = false;
    bool okSacdIso = false;
    {
        const auto asioDrivers = vanta_asio::EnumerateAsioDrivers();
        okAsioEnum = true;
        for (const auto& d : asioDrivers) {
            if (d.name.empty() || d.clsid.empty()) {
                okAsioEnum = false;
                break;
            }
        }

        WCHAR tmpDirW[MAX_PATH] = {};
        if (GetTempPathW(MAX_PATH, tmpDirW) > 0) {
            const std::wstring baseW = std::wstring(tmpDirW) + L"vanta_p2_selftest_" + std::to_wstring(GetCurrentProcessId());
            const std::wstring dsf512W = baseW + L"_dsd512.dsf";
            const std::wstring isoSacdW = baseW + L"_sacd.iso";

            // Build synthetic minimal DSD512 (22,579,200 Hz) DSF file
            {
                FILE* fp = nullptr;
                if (_wfopen_s(&fp, dsf512W.c_str(), L"wb") == 0 && fp) {
                    const uint32_t blockSize = 4096u;
                    const uint16_t ch = 2u;
                    auto wU32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, fp); };
                    auto wU64 = [&](uint64_t v) { std::fwrite(&v, 8, 1, fp); };
                    const uint64_t dataPayload = static_cast<uint64_t>(blockSize) * ch;
                    const uint64_t totalFile = 28ULL + 52ULL + 12ULL + dataPayload;
                    // "DSD " header
                    std::fwrite("DSD ", 1, 4, fp); wU64(28ULL); wU64(totalFile); wU64(0ULL);
                    // "fmt " header (52 bytes)
                    std::fwrite("fmt ", 1, 4, fp); wU64(52ULL); wU32(1u); wU32(0u); wU32(2u); wU32(ch);
                    wU32(22579200u); wU32(1u); wU64(static_cast<uint64_t>(blockSize) * 8ULL); wU32(blockSize); wU32(0u);
                    // "data" header
                    std::fwrite("data", 1, 4, fp); wU64(12ULL + dataPayload);
                    std::vector<uint8_t> ch0(blockSize, 0xA3u); // L channel pattern
                    std::vector<uint8_t> ch1(blockSize, 0x5Cu); // R channel pattern
                    std::fwrite(ch0.data(), 1, blockSize, fp);
                    std::fwrite(ch1.data(), 1, blockSize, fp);
                    std::fclose(fp);

                    DopStreamReader dsd512Reader;
                    std::string err;
                    if (dsd512Reader.Open(WideToUtf8(dsf512W.c_str()), 0.0, err, true) &&
                        dsd512Reader.DsdSampleRate() == 22579200u &&
                        dsd512Reader.DsdLabel() == "DSD512") {
                        std::vector<uint8_t> outMsb(8);
                        const size_t got = dsd512Reader.ReadRawDsdOctetFrames(outMsb.data(), 4, true);
                        // 0xA3 bit-reversed = 0xC5; 0x5C bit-reversed = 0x3A
                        okDsd512Raw = (got == 4 && outMsb[0] == 0xC5u && outMsb[1] == 0x3Au);
                    }
                    DeleteFileW(dsf512W.c_str());
                }
            }

            // Build synthetic minimal ScarletBook SACD ISO (LSN 510 Master TOC + Area TOC + Track 1 audio sector)
            {
                FILE* fp = nullptr;
                if (_wfopen_s(&fp, isoSacdW.c_str(), L"wb") == 0 && fp) {
                    const size_t secSize = 2048u;
                    const size_t totalSectors = 520u;
                    std::vector<uint8_t> isoImg(totalSectors * secSize, 0u);
                    auto putBe16 = [](uint8_t* p, uint16_t v) {
                        p[0] = static_cast<uint8_t>(v >> 8); p[1] = static_cast<uint8_t>(v & 0xFFu);
                    };
                    auto putBe32 = [](uint8_t* p, uint32_t v) {
                        p[0] = static_cast<uint8_t>(v >> 24); p[1] = static_cast<uint8_t>(v >> 16);
                        p[2] = static_cast<uint8_t>(v >> 8); p[3] = static_cast<uint8_t>(v & 0xFFu);
                    };
                    // Master TOC at LSN 510
                    uint8_t* mtoc = isoImg.data() + 510u * secSize;
                    std::memcpy(mtoc, "SACDMTOC", 8);
                    mtoc[8] = 1; mtoc[9] = 20;
                    std::memcpy(mtoc + 24, "VANTA-SACD-01   ", 16);
                    putBe32(mtoc + 64, 512u); // area_1_toc_1_start
                    putBe16(mtoc + 84, 4u);   // area_1_toc_size

                    // Area 1 TOC at LSN 512 ("TWOCHTOC")
                    uint8_t* atoc = isoImg.data() + 512u * secSize;
                    std::memcpy(atoc, "TWOCHTOC", 8);
                    atoc[20] = 4u; // 2822400 Hz
                    atoc[21] = 2u; // FRAME_FORMAT_DSD_3_IN_14
                    atoc[32] = 2u; // Stereo

                    // SACDTRL1 at LSN 513
                    uint8_t* trl1 = isoImg.data() + 513u * secSize;
                    std::memcpy(trl1, "SACDTRL1", 8);
                    putBe32(trl1 + 8, 516u);          // Track 1 start LSN
                    putBe32(trl1 + 8 + 255 * 4, 2u);  // Track 1 length = 2 sectors

                    // SACDTRL2 at LSN 514
                    uint8_t* trl2 = isoImg.data() + 514u * secSize;
                    std::memcpy(trl2, "SACDTRL2", 8);
                    uint8_t* dur1 = trl2 + 8 + 255 * 4;
                    dur1[0] = 0; dur1[1] = 1; dur1[2] = 0; // 1.0 sec

                    // SACDTTxt at LSN 515
                    uint8_t* ttxt = isoImg.data() + 515u * secSize;
                    std::memcpy(ttxt, "SACDTTxt", 8);
                    putBe16(ttxt + 8, 64u);
                    ttxt[64] = 0x01; // Title
                    std::memcpy(ttxt + 65, "Audiophile Test\0", 16);

                    // Audio sector at LSN 516: 1 packet, 1 frame, uncompressed DSD (12 bytes)
                    uint8_t* asec = isoImg.data() + 516u * secSize;
                    asec[0] = (1u << 5) | (1u << 2) | 0u; // pktCount=1, frmCount=1, dst=0
                    putBe16(asec + 1, static_cast<uint16_t>((1u << 15) | (2u << 11) | 16u)); // frameStart=1, DATA_TYPE_AUDIO=2, len=16
                    std::memset(asec + 6, 0x69u, 16u);

                    std::fwrite(isoImg.data(), 1, isoImg.size(), fp);
                    std::fclose(fp);

                    vanta_sacd::SacdIsoReader isoReader;
                    std::string iErr;
                    if (isoReader.Open(WideToUtf8(isoSacdW.c_str()), iErr)) {
                        const auto& disc = isoReader.DiscInfo();
                        if (disc.ok && !disc.areas.empty() && !disc.areas[0].tracks.empty() &&
                            disc.areas[0].tracks[0].title == "Audiophile Test" &&
                            disc.areas[0].tracks[0].sampleRate == 2822400u) {
                            std::vector<uint8_t> dffStream;
                            okSacdIso = isoReader.StreamTrackAsDsdiff(0, 1, [&](const uint8_t* d, size_t n) {
                                dffStream.insert(dffStream.end(), d, d + n);
                                return true;
                            }, iErr) && dffStream.size() >= 32 && std::memcmp(dffStream.data(), "FRM8", 4) == 0;
                        }
                    }
                    DeleteFileW(isoSacdW.c_str());
                }
            }
        }
    }

    // 17. 32-Band Parametric EQ (PK/LSC/HSC/LPQ/HPQ/NO/AP) + AutoEQ Preamp + Unity Bypass
    bool okPeq32AutoEq = false;
    {
        DspConfigSnapshot cfg{};
        cfg.peq = ParsePeqSpec("-4.5;LSC,105,0.70,5.5;PK,1000,6.0,-18.0;HSC,8000,0.71,2.0;LPQ,18000,0.707,0;HPQ,20,0.707,0;NO,4000,8.0,0;AP,2500,0.707,0");
        PurePathDspRack64 rack;
        rack.ApplyConfig(48000, cfg);

        // Verify 1 kHz notch/peaking attenuation & zero NaN/Inf across 1024 frames
        double rms1k = 0.0;
        bool finiteAll = true;
        for (int i = 0; i < 2048; ++i) {
            const double sig = 0.5 * std::sin(2.0 * VANTA_PI * 1000.0 * i / 48000.0);
            double fr[2] = { sig, sig };
            rack.ProcessFrame(fr, 2);
            if (!std::isfinite(fr[0]) || !std::isfinite(fr[1])) finiteAll = false;
            if (i >= 1024) rms1k += fr[0] * fr[0];
        }
        rms1k = std::sqrt(rms1k / 1024.0);

        // Switching PEQ off restores clean unity
        cfg.peq = ParsePeqSpec("");
        rack.ApplyConfig(48000, cfg);
        rack.ResetStates();
        double maxErr = 0.0;
        for (int i = 0; i < 256; ++i) {
            const double orig = 0.4 * std::sin(2.0 * VANTA_PI * 1000.0 * i / 48000.0);
            double fr[2] = { orig, -orig };
            rack.ProcessFrame(fr, 2);
            maxErr = std::max(maxErr, std::fabs(fr[0] - orig));
        }
        okPeq32AutoEq = finiteAll && (rms1k > 0.0) && (rms1k < 0.08) && (maxErr < 1e-14);
    }

    // 18. 64-Bit Uniform Partitioned FFT Convolver (Zero-Latency Dirac + Partition-Boundary Tail + 65536-Tap @ 192kHz Benchmark)
    bool okFftConvolver = false;
    {
        using namespace vanta_convolver;
        // (a) Dirac unit impulse preserves input bit-exact (< 1e-13)
        WavIrData diracWav{};
        diracWav.sampleRate = 48000;
        diracWav.channels = 2;
        diracWav.frameCount = 1;
        diracWav.ch = { { 1.0 }, { 1.0 } };

        ConvolverHost64 host;
        std::wstring dummyW;
        std::string cErr;
        bool loadedDirac = host.LoadFromWavData(diracWav, 48000, 1.0, cErr);
        double diracErr = 1.0;
        if (loadedDirac) {
            diracErr = 0.0;
            auto* slot = host.AcquireActiveForRender();
            for (int f = 0; f < 1024; ++f) {
                const double inL = std::sin(2.0 * VANTA_PI * 777.0 * f / 48000.0);
                const double inR = std::cos(2.0 * VANTA_PI * 555.0 * f / 48000.0);
                double oL = inL, oR = inR;
                if (slot) slot->ProcessStereoFrame(oL, oR);
                diracErr = std::max(diracErr, std::max(std::fabs(oL - inL), std::fabs(oR - inR)));
            }
            host.ReleaseRenderSlot();
        }

        // (b) Delayed impulse h[600] = 0.5 crosses kPartSize=512 tail partition boundary cleanly
        WavIrData delayWav{};
        delayWav.sampleRate = 48000;
        delayWav.channels = 1;
        delayWav.frameCount = 700;
        delayWav.ch.assign(1, std::vector<double>(700, 0.0));
        delayWav.ch[0][600] = 0.5;
        bool loadedDelay = host.LoadFromWavData(delayWav, 48000, 1.0, cErr);
        double delayAt600 = 0.0;
        double delayOtherMax = 0.0;
        if (loadedDelay) {
            auto* slot = host.AcquireActiveForRender();
            for (int f = 0; f < 1200; ++f) {
                double l = (f == 0) ? 1.0 : 0.0;
                double r = l;
                if (slot) slot->ProcessStereoFrame(l, r);
                if (f == 600) delayAt600 = l;
                else delayOtherMax = std::max(delayOtherMax, std::fabs(l));
            }
            host.ReleaseRenderSlot();
        }

        // (c) 65,536-tap @ 192 kHz stereo real-time stress check (16,384 frames = 85.33 ms audio)
        WavIrData bigIr{};
        bigIr.sampleRate = 192000;
        bigIr.channels = 2;
        bigIr.frameCount = 65536;
        bigIr.ch.assign(2, std::vector<double>(65536, 0.0));
        bigIr.ch[0][0] = 0.8;
        bigIr.ch[0][32768] = 0.15;
        bigIr.ch[1][0] = 0.8;
        bigIr.ch[1][65000] = 0.1;
        size_t bigTaps = 0;
        bool loadedBig = host.LoadFromWavData(bigIr, 192000, 1.0, cErr, &bigTaps);
        bool bigOk = false;
        if (loadedBig && bigTaps == 65536) {
            LARGE_INTEGER freqQpc{}, t0{}, t1{};
            QueryPerformanceFrequency(&freqQpc);
            QueryPerformanceCounter(&t0);
            auto* slot = host.AcquireActiveForRender();
            bool finiteBig = true;
            double energySum = 0.0;
            for (int f = 0; f < 16384; ++f) {
                double l = 0.25 * std::sin(2.0 * VANTA_PI * 1000.0 * f / 192000.0);
                double r = -l;
                if (slot) slot->ProcessStereoFrame(l, r);
                if (!std::isfinite(l) || !std::isfinite(r)) finiteBig = false;
                energySum += l * l;
            }
            host.ReleaseRenderSlot();
            QueryPerformanceCounter(&t1);
            const double elapsedMs = static_cast<double>(t1.QuadPart - t0.QuadPart) * 1000.0 / static_cast<double>(freqQpc.QuadPart);
            // 16384 frames @ 192kHz = 85.333 ms real-time budget
            bigOk = finiteBig && (energySum > 1.0) && (elapsedMs < 80.0);
        }
        (void)dummyW;
        okFftConvolver = loadedDirac && (diracErr < 1e-13) && loadedDelay && (std::fabs(delayAt600 - 0.5) < 1e-13) && (delayOtherMax < 1e-13) && bigOk;
    }

    // 19. Live Bit-Audit (16-in-32 vs 24-bit) & 4x Oversampled True-Peak Meter
    bool okLiveBitAudit = false;
    {
        const uint32_t frames = 512;
        std::vector<int32_t> pcm16Padded(frames * 2);
        std::vector<int32_t> pcm24Active(frames * 2);
        for (uint32_t f = 0; f < frames; ++f) {
            const int16_t s16 = static_cast<int16_t>((f & 1u) ? 16383 : -16383);
            pcm16Padded[f * 2] = static_cast<int32_t>(static_cast<uint32_t>(static_cast<uint16_t>(s16)) << 16);
            pcm16Padded[f * 2 + 1] = pcm16Padded[f * 2];

            const int32_t s24 = static_cast<int32_t>((f & 1u) ? 4194301 : -4194301); // bit 0 of 24-bit active!
            pcm24Active[f * 2] = static_cast<int32_t>(static_cast<uint32_t>(s24) << 8);
            pcm24Active[f * 2 + 1] = pcm24Active[f * 2];
        }
        std::vector<int32_t> sinkOut(frames * 2);
        PurePathDspRack64 rack;
        rack.ApplyConfig(48000, DspConfigSnapshot{});
        TruePeakLimiter64 lim;
        TpdfDitherShaper64 dither;
        float fftRing[FFT_N] = {};
        size_t fftPos = 0;
        TelemetryFrameStats stats{};
        AudioAnalysisMeters64 meters16, meters24, metersTp;
        ConvertAndWriteFrames(reinterpret_cast<BYTE*>(sinkOut.data()), pcm16Padded.data(), frames, 2, WireSampleFormat::Pcm32, 1.0f, rack, lim, dither, fftRing, fftPos, stats, 24, nullptr, &meters16, 48000);
        ConvertAndWriteFrames(reinterpret_cast<BYTE*>(sinkOut.data()), pcm24Active.data(), frames, 2, WireSampleFormat::Pcm32, 1.0f, rack, lim, dither, fftRing, fftPos, stats, 24, nullptr, &meters24, 48000);

        const double tpSeq[4] = { 0.9, 0.9, -0.9, -0.9 };
        for (int i = 0; i < 4; ++i) {
            metersTp.PushOutputSample(tpSeq[i], 0, 0u, 0u);
        }
        const double tpDbtp = metersTp.ReadWindowTruePeakDbtpAndReset();
        okLiveBitAudit = (meters16.CurrentSrcActiveBits() == 16u) &&
            (meters24.CurrentSrcActiveBits() == 24u) &&
            (tpDbtp > 0.0);
    }

    const bool allResults[] = {
        okRing, okBitExact32, okBitExact24, okPurePathUnity, okPurePathEq,
        okTruePeakInterSample, okTpdf16, okDopMarkers, okBackendLifecycle,
        okF64leHeadroom, okSmartDither24To16, okPushMode, okCrossRateReinit,
        okAsioEnum, okDsd512Raw, okSacdIso,
        okPeq32AutoEq, okFftConvolver, okLiveBitAudit
    };
    int passed = 0;
    int failed = 0;
    for (bool b : allResults) {
        if (b) ++passed;
        else ++failed;
    }

    const std::string json = std::string("{\"ok\":") + (failed == 0 ? "true" : "false") +
        ",\"passed\":" + std::to_string(passed) +
        ",\"failed\":" + std::to_string(failed) +
        ",\"tests\":{\"ringBuffer\":" + (okRing ? "true" : "false") +
        ",\"bitExactPcm32\":" + (okBitExact32 ? "true" : "false") +
        ",\"bitExactPcm24Packed\":" + (okBitExact24 ? "true" : "false") +
        ",\"purePathUnity\":" + (okPurePathUnity ? "true" : "false") +
        ",\"purePathEq\":" + (okPurePathEq ? "true" : "false") +
        ",\"truePeakInterSample\":" + (okTruePeakInterSample ? "true" : "false") +
        ",\"tpdfDither16\":" + (okTpdf16 ? "true" : "false") +
        ",\"dopMarkerAlternation\":" + (okDopMarkers ? "true" : "false") +
        ",\"backendLifecycle\":" + (okBackendLifecycle ? "true" : "false") +
        ",\"f64leHeadroom\":" + (okF64leHeadroom ? "true" : "false") +
        ",\"smartDither24To16\":" + (okSmartDither24To16 ? "true" : "false") +
        ",\"pushModeLifecycle\":" + (okPushMode ? "true" : "false") +
        ",\"crossRateReinit\":" + (okCrossRateReinit ? "true" : "false") +
        ",\"asioDriverEnumeration\":" + (okAsioEnum ? "true" : "false") +
        ",\"dsd512RawPacker\":" + (okDsd512Raw ? "true" : "false") +
        ",\"sacdIsoScarletBookParse\":" + (okSacdIso ? "true" : "false") +
        ",\"peq32AutoEqStability\":" + (okPeq32AutoEq ? "true" : "false") +
        ",\"fftConvolverDiracAndPerf192k\":" + (okFftConvolver ? "true" : "false") +
        ",\"liveMetersBitAuditAndTruePeak\":" + (okLiveBitAudit ? "true" : "false") + "}}";
    EmitJsonLine(json);
    return failed == 0 ? 0 : 12;
}

int ProbeDeviceCaps(const std::string& deviceId, uint16_t channels) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        EmitJsonLine("{\"ok\":false,\"error\":\"CoInitializeEx failed\"}");
        return 1;
    }

    IMMDeviceEnumerator* pEnum = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&pEnum));
    if (FAILED(hr) || !pEnum) {
        CoUninitialize();
        EmitJsonLine("{\"ok\":false,\"error\":\"MMDeviceEnumerator creation failed\"}");
        return 2;
    }

    IMMDevice* pDevice = nullptr;
    if (!deviceId.empty()) {
        const std::wstring wid = Utf8ToWide(deviceId);
        hr = pEnum->GetDevice(wid.c_str(), &pDevice);
        if (FAILED(hr) || !pDevice) {
            hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        }
    } else {
        hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    }

    if (FAILED(hr) || !pDevice) {
        pEnum->Release();
        CoUninitialize();
        EmitJsonLine("{\"ok\":false,\"error\":\"No active audio output device found\"}");
        return 3;
    }

    std::string resolvedId = deviceId;
    LPWSTR pIdStr = nullptr;
    if (SUCCEEDED(pDevice->GetId(&pIdStr)) && pIdStr) {
        resolvedId = WideToUtf8(pIdStr);
        CoTaskMemFree(pIdStr);
    }
    const std::string deviceName = ReadDeviceFriendlyName(pDevice);

    DWORD hwSupport = 0;
    IAudioEndpointVolume* pVol = nullptr;
    if (SUCCEEDED(pDevice->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pVol))) && pVol) {
        pVol->QueryHardwareSupport(&hwSupport);
        pVol->Release();
    }

    IAudioClient* pAudioClient = nullptr;
    hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pAudioClient));
    if (FAILED(hr) || !pAudioClient) {
        pDevice->Release();
        pEnum->Release();
        CoUninitialize();
        EmitJsonLine("{\"ok\":false,\"error\":\"IAudioClient activation failed\"}");
        return 4;
    }

    uint32_t sharedRate = 48000;
    uint16_t sharedChannels = 2;
    WAVEFORMATEX* pMixFmt = nullptr;
    if (SUCCEEDED(pAudioClient->GetMixFormat(&pMixFmt)) && pMixFmt) {
        sharedRate = pMixFmt->nSamplesPerSec;
        sharedChannels = pMixFmt->nChannels;
        CoTaskMemFree(pMixFmt);
    }

    const uint32_t rates[] = { 44100u, 48000u, 88200u, 96000u, 176400u, 192000u, 352800u, 384000u, 705600u, 768000u };
    struct Cand { uint16_t container; uint16_t valid; bool isFloat; };
    const Cand cands[] = { {32, 32, false}, {32, 24, false}, {24, 24, false}, {32, 32, true}, {16, 16, false} };
    const uint16_t ch = (channels >= 1 && channels <= 8) ? channels : 2;

    std::vector<uint32_t> supportedRates;
    uint16_t maxBitDepth = 0;
    bool supports16 = false;
    bool supports24 = false;
    bool supports32 = false;

    for (uint32_t r : rates) {
        bool rateSupported = false;
        for (const auto& c : cands) {
            WAVEFORMATEXTENSIBLE wfx = BuildFormat(r, ch, c.container, c.valid, c.isFloat);
            if (pAudioClient->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, reinterpret_cast<WAVEFORMATEX*>(&wfx), nullptr) == S_OK) {
                rateSupported = true;
                if (c.valid >= 32 && !c.isFloat) { supports32 = true; maxBitDepth = std::max<uint16_t>(maxBitDepth, 32); }
                else if (c.valid == 24) { supports24 = true; maxBitDepth = std::max<uint16_t>(maxBitDepth, 24); }
                else if (c.valid == 16) { supports16 = true; maxBitDepth = std::max<uint16_t>(maxBitDepth, 16); }
                else if (c.isFloat) { maxBitDepth = std::max<uint16_t>(maxBitDepth, 32); }
            }
        }
        if (rateSupported) {
            supportedRates.push_back(r);
        }
    }

    pAudioClient->Release();
    pDevice->Release();
    pEnum->Release();
    CoUninitialize();

    std::string json = "{\"ok\":true,\"deviceId\":\"" + EscapeJson(resolvedId) +
        "\",\"deviceName\":\"" + EscapeJson(deviceName) +
        "\",\"exclusiveSupported\":" + (supportedRates.empty() ? "false" : "true") +
        ",\"sharedSampleRate\":" + std::to_string(sharedRate) +
        ",\"sharedChannels\":" + std::to_string(sharedChannels) +
        ",\"hwVolumeSupport\":" + std::to_string(hwSupport) +
        ",\"maxBitDepth\":" + std::to_string(maxBitDepth) +
        ",\"supports16Bit\":" + (supports16 ? "true" : "false") +
        ",\"supports24Bit\":" + (supports24 ? "true" : "false") +
        ",\"supports32Bit\":" + (supports32 ? "true" : "false") +
        ",\"supportedRates\":[";
    for (size_t i = 0; i < supportedRates.size(); ++i) {
        if (i > 0) json += ",";
        json += std::to_string(supportedRates[i]);
    }
    json += "]}";
    EmitJsonLine(json);
    return 0;
}

int ListAsioDevices() {
    const auto drivers = vanta_asio::EnumerateAsioDrivers();
    std::string json = "[";
    for (size_t i = 0; i < drivers.size(); ++i) {
        if (i > 0) json += ",";
        json += "{\"name\":\"" + EscapeJson(drivers[i].name) +
            "\",\"clsid\":\"" + EscapeJson(drivers[i].clsid) +
            "\",\"description\":\"" + EscapeJson(drivers[i].description) + "\"}";
    }
    json += "]";
    EmitJsonLine(json);
    return 0;
}

int ListSacdIso(const std::string& isoPath) {
    vanta_sacd::SacdIsoReader reader;
    std::string err;
    if (!reader.Open(isoPath, err)) {
        EmitJsonLine("{\"ok\":false,\"error\":\"" + EscapeJson(err) + "\",\"areas\":[]}");
        return 1;
    }
    const auto& disc = reader.DiscInfo();
    std::string json = "{\"ok\":true,\"catalogNumber\":\"" + EscapeJson(disc.albumCatalogNumber) + "\",\"areas\":[";
    for (size_t ai = 0; ai < disc.areas.size(); ++ai) {
        const auto& a = disc.areas[ai];
        if (ai > 0) json += ",";
        json += "{\"areaIndex\":" + std::to_string(a.areaIndex) +
            ",\"areaName\":\"" + EscapeJson(a.areaName) +
            "\",\"channels\":" + std::to_string(a.channels) +
            ",\"sampleRate\":" + std::to_string(a.sampleRate) +
            ",\"isDst\":" + (a.isDst ? "true" : "false") +
            ",\"tracks\":[";
        for (size_t ti = 0; ti < a.tracks.size(); ++ti) {
            const auto& t = a.tracks[ti];
            if (ti > 0) json += ",";
            char durBuf[32];
            std::snprintf(durBuf, sizeof(durBuf), "%.3f", t.durationSec);
            json += "{\"trackNumber\":" + std::to_string(t.trackNumber) +
                ",\"areaIndex\":" + std::to_string(t.areaIndex) +
                ",\"title\":\"" + EscapeJson(t.title) +
                "\",\"artist\":\"" + EscapeJson(t.artist) +
                "\",\"channels\":" + std::to_string(t.channels) +
                ",\"sampleRate\":" + std::to_string(t.sampleRate) +
                ",\"isDst\":" + (t.isDst ? "true" : "false") +
                ",\"startLsn\":" + std::to_string(t.startLsn) +
                ",\"lengthLsn\":" + std::to_string(t.lengthLsn) +
                ",\"durationSec\":" + std::string(durBuf) + "}";
        }
        json += "]}";
    }
    json += "]}";
    EmitJsonLine(json);
    return 0;
}

int ExtractSacdTrackToStdout(const std::string& isoPath, uint32_t areaIndex, uint32_t trackNumber1Based) {
    vanta_sacd::SacdIsoReader reader;
    std::string err;
    if (!reader.Open(isoPath, err)) {
        std::fprintf(stderr, "SACD ISO open failed: %s\n", err.c_str());
        return 1;
    }
    _setmode(_fileno(stdout), _O_BINARY);
    const bool ok = reader.StreamTrackAsDsdiff(areaIndex, trackNumber1Based, [&](const uint8_t* data, size_t len) -> bool {
        if (!data || len == 0) return true;
        return std::fwrite(data, 1, len, stdout) == len;
    }, err);
    std::fflush(stdout);
    if (!ok) {
        std::fprintf(stderr, "SACD ISO stream failed: %s\n", err.c_str());
        return 1;
    }
    return 0;
}

struct EngineOptions {
    bool listDevices = false;
    bool listAsioDevices = false;
    bool probeCaps = false;
    bool volumeMonitor = false;
    bool selfTest = false;
    bool exclusive = true;
    bool pushMode = false;
    bool asio = false;
    bool rawDsd = false;
    bool limiterEnabled = false;
    uint32_t sampleRate = 48000;
    uint16_t channels = DEFAULT_CHANNELS;
    uint16_t srcBits = 24;
    uint32_t bufferMs = 0;
    uint32_t preRollMs = 0;
    uint32_t sacdArea = 0;
    uint32_t sacdTrack = 1;
    InputWireFormat inFmt = InputWireFormat::S32LE;
    float initialGain = 1.0f;
    double seekSec = 0.0;
    std::string deviceId;
    std::string asioDriver;
    std::string ctrlPipeName;
    std::string dopFile;
    std::string testDopFile;
    std::string listSacdIso;
    std::string extractSacdIso;
    std::string dspSpec;
    std::string peqSpec;
    std::string convolverIrPath;
    double convolverWetPct = 100.0;
};

EngineOptions ParseArgs(int argc, char** argv) {
    EngineOptions opts;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--list-devices") {
            opts.listDevices = true;
        } else if (arg == "--list-asio-devices") {
            opts.listAsioDevices = true;
        } else if (arg == "--probe-caps") {
            opts.probeCaps = true;
        } else if (arg == "--volume-monitor") {
            opts.volumeMonitor = true;
        } else if (arg == "--self-test") {
            opts.selfTest = true;
        } else if (arg == "--shared") {
            opts.exclusive = false;
        } else if (arg == "--exclusive") {
            opts.exclusive = true;
        } else if (arg == "--push") {
            opts.pushMode = true;
        } else if (arg == "--event") {
            opts.pushMode = false;
        } else if (arg == "--asio") {
            opts.asio = true;
            opts.exclusive = true;
        } else if (arg == "--asio-driver" && i + 1 < argc) {
            opts.asioDriver = argv[++i];
            opts.asio = true;
        } else if (arg == "--dsd-raw") {
            opts.rawDsd = true;
        } else if (arg == "--limiter") {
            opts.limiterEnabled = true;
        } else if (arg == "--dsp" && i + 1 < argc) {
            opts.dspSpec = argv[++i];
        } else if (arg == "--peq" && i + 1 < argc) {
            opts.peqSpec = argv[++i];
        } else if (arg == "--convolver-ir" && i + 1 < argc) {
            opts.convolverIrPath = argv[++i];
        } else if (arg == "--convolver-wet" && i + 1 < argc) {
            opts.convolverWetPct = ClampDouble(std::strtod(argv[++i], nullptr), 0.0, 100.0);
        } else if (arg == "--rate" && i + 1 < argc) {
            opts.sampleRate = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--channels" && i + 1 < argc) {
            opts.channels = static_cast<uint16_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--src-bits" && i + 1 < argc) {
            opts.srcBits = static_cast<uint16_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--buffer-ms" && i + 1 < argc) {
            opts.bufferMs = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--pre-roll-ms" && i + 1 < argc) {
            opts.preRollMs = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--in-fmt" && i + 1 < argc) {
            opts.inFmt = ParseInputWireFormat(argv[++i]);
        } else if (arg == "--gain" && i + 1 < argc) {
            opts.initialGain = std::strtof(argv[++i], nullptr);
        } else if (arg == "--seek-sec" && i + 1 < argc) {
            opts.seekSec = std::strtod(argv[++i], nullptr);
        } else if (arg == "--device" && i + 1 < argc) {
            opts.deviceId = argv[++i];
        } else if (arg == "--ctrl-pipe" && i + 1 < argc) {
            opts.ctrlPipeName = argv[++i];
        } else if (arg == "--dop-file" && i + 1 < argc) {
            opts.dopFile = argv[++i];
        } else if (arg == "--test-dop" && i + 1 < argc) {
            opts.testDopFile = argv[++i];
        } else if (arg == "--list-sacd" && i + 1 < argc) {
            opts.listSacdIso = argv[++i];
        } else if (arg == "--sacd-extract-dff" && i + 1 < argc) {
            opts.extractSacdIso = argv[++i];
        } else if (arg == "--sacd-area" && i + 1 < argc) {
            opts.sacdArea = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--sacd-track" && i + 1 < argc) {
            opts.sacdTrack = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        }
    }
    const uint32_t maxRate = (opts.asio && opts.rawDsd) ? 49152000u : 768000u;
    if (opts.sampleRate < 8000 || opts.sampleRate > maxRate) opts.sampleRate = 48000;
    if (opts.channels < 1 || opts.channels > 8) opts.channels = 2;
    if (opts.srcBits < 8 || opts.srcBits > 64) opts.srcBits = 24;
    if (opts.bufferMs > 200) opts.bufferMs = 200;
    if (opts.preRollMs > 500) opts.preRollMs = 500;
    if (opts.seekSec < 0.0) opts.seekSec = 0.0;
    if (opts.sacdTrack == 0) opts.sacdTrack = 1;
    return opts;
}

static const GUID VANTA_VOL_CTX = {
    0x7a91c4e2, 0x3b18, 0x4d92, { 0x9f, 0x41, 0x62, 0x8d, 0xe3, 0x10, 0xa5, 0x7b }
};

class EndpointVolumeWatcher final : public IAudioEndpointVolumeCallback {
public:
    EndpointVolumeWatcher() : refCount_(1) {}

    ULONG STDMETHODCALLTYPE AddRef() override {
        return static_cast<ULONG>(InterlockedIncrement(&refCount_));
    }

    ULONG STDMETHODCALLTYPE Release() override {
        ULONG rc = static_cast<ULONG>(InterlockedDecrement(&refCount_));
        if (rc == 0) delete this;
        return rc;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == __uuidof(IAudioEndpointVolumeCallback)) {
            *ppv = static_cast<IAudioEndpointVolumeCallback*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    HRESULT STDMETHODCALLTYPE OnNotify(PAUDIO_VOLUME_NOTIFICATION_DATA pNotify) override {
        if (!pNotify) return S_OK;
        const bool external = !IsEqualGUID(pNotify->guidEventContext, VANTA_VOL_CTX);
        if (external) {
            char buf[160];
            std::snprintf(
                buf,
                sizeof(buf),
                "{\"event\":\"volume\",\"level\":%.4f,\"muted\":%s,\"external\":true}",
                pNotify->fMasterVolume,
                pNotify->bMuted ? "true" : "false"
            );
            EmitJsonLine(buf);
        }
        return S_OK;
    }

private:
    LONG refCount_;
};

class DeviceNotificationWatcher final : public IMMNotificationClient {
public:
    explicit DeviceNotificationWatcher(HANDLE hChangedEvent)
        : refCount_(1), hChangedEvent_(hChangedEvent) {}

    ULONG STDMETHODCALLTYPE AddRef() override {
        return static_cast<ULONG>(InterlockedIncrement(&refCount_));
    }

    ULONG STDMETHODCALLTYPE Release() override {
        ULONG rc = static_cast<ULONG>(InterlockedDecrement(&refCount_));
        if (rc == 0) delete this;
        return rc;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == __uuidof(IMMNotificationClient)) {
            *ppv = static_cast<IMMNotificationClient*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR /*pwstrDeviceId*/, DWORD /*dwNewState*/) override {
        if (hChangedEvent_) SetEvent(hChangedEvent_);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR /*pwstrDeviceId*/) override {
        if (hChangedEvent_) SetEvent(hChangedEvent_);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR /*pwstrDeviceId*/) override {
        if (hChangedEvent_) SetEvent(hChangedEvent_);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR /*pwstrDefaultDeviceId*/) override {
        if (flow == eRender && role == eConsole && hChangedEvent_) {
            SetEvent(hChangedEvent_);
        }
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR /*pwstrDeviceId*/, const PROPERTYKEY /*key*/) override {
        return S_OK;
    }

private:
    LONG refCount_;
    HANDLE hChangedEvent_;
};

int RunVolumeMonitor(const std::string& initialDeviceId) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 1;

    IMMDeviceEnumerator* pEnum = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&pEnum));
    if (FAILED(hr) || !pEnum) {
        CoUninitialize();
        return 2;
    }

    IMMDevice* pDevice = nullptr;
    IAudioEndpointVolume* pEndpointVol = nullptr;
    EndpointVolumeWatcher* pWatcher = new EndpointVolumeWatcher();
    HANDLE hChangedEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    DeviceNotificationWatcher* pDevWatcher = new DeviceNotificationWatcher(hChangedEvent);
    std::mutex volMutex;
    std::string activePinnedId = initialDeviceId;
    std::atomic<bool> stopMonitor{false};

    auto bindEndpoint = [&](const std::string& devId) {
        std::lock_guard<std::mutex> lock(volMutex);
        activePinnedId = devId;
        if (pEndpointVol) {
            pEndpointVol->UnregisterControlChangeNotify(pWatcher);
            pEndpointVol->Release();
            pEndpointVol = nullptr;
        }
        if (pDevice) {
            pDevice->Release();
            pDevice = nullptr;
        }

        HRESULT devHr = E_FAIL;
        if (!devId.empty()) {
            std::wstring wid = Utf8ToWide(devId);
            devHr = pEnum->GetDevice(wid.c_str(), &pDevice);
        }
        if (FAILED(devHr) || !pDevice) {
            devHr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        }
        if (FAILED(devHr) || !pDevice) return;

        if (FAILED(pDevice->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pEndpointVol))) || !pEndpointVol) {
            return;
        }
        pEndpointVol->RegisterControlChangeNotify(pWatcher);

        float level = 1.0f;
        BOOL muted = FALSE;
        DWORD hwSupport = 0;
        pEndpointVol->GetMasterVolumeLevelScalar(&level);
        pEndpointVol->GetMute(&muted);
        pEndpointVol->QueryHardwareSupport(&hwSupport);
        const std::string devName = ReadDeviceFriendlyName(pDevice);
        char buf[384];
        std::snprintf(
            buf,
            sizeof(buf),
            "{\"event\":\"volume\",\"level\":%.4f,\"muted\":%s,\"hwSupport\":%lu,\"external\":true,\"deviceName\":\"%s\"}",
            level,
            muted ? "true" : "false",
            static_cast<unsigned long>(hwSupport),
            EscapeJson(devName).c_str()
        );
        EmitJsonLine(buf);
    };

    bindEndpoint(initialDeviceId);
    pEnum->RegisterEndpointNotificationCallback(pDevWatcher);

    // Debounced hot-plug worker safely outside MMDevice callback context
    std::thread devChangeThread([&]() {
        while (!stopMonitor.load()) {
            if (WaitForSingleObject(hChangedEvent, 500) != WAIT_OBJECT_0) continue;
            if (stopMonitor.load()) break;
            Sleep(180); // Coalesce Bluetooth A2DP + HFP simultaneous profile arrivals
            if (stopMonitor.load()) break;
            EmitJsonLine("{\"event\":\"devices_changed\"}");
            std::string curId;
            {
                std::lock_guard<std::mutex> lock(volMutex);
                curId = activePinnedId;
            }
            bindEndpoint(curId);
        }
    });

    char lineBuf[512];
    while (std::fgets(lineBuf, sizeof(lineBuf), stdin)) {
        std::string cmd(lineBuf);
        while (!cmd.empty() && (cmd.back() == '\n' || cmd.back() == '\r')) cmd.pop_back();
        if (cmd.empty()) continue;
        if (cmd == "QUIT") break;

        if (cmd.rfind("VOL ", 0) == 0) {
            float val = std::strtof(cmd.c_str() + 4, nullptr);
            if (val < 0.0f) val = 0.0f;
            if (val > 1.0f) val = 1.0f;
            std::lock_guard<std::mutex> lock(volMutex);
            if (pEndpointVol) {
                pEndpointVol->SetMasterVolumeLevelScalar(val, &VANTA_VOL_CTX);
                if (val > 0.0f) {
                    pEndpointVol->SetMute(FALSE, &VANTA_VOL_CTX);
                }
            }
        } else if (cmd.rfind("MUTE ", 0) == 0) {
            const bool m = (cmd.c_str()[5] == '1');
            std::lock_guard<std::mutex> lock(volMutex);
            if (pEndpointVol) {
                pEndpointVol->SetMute(m ? TRUE : FALSE, &VANTA_VOL_CTX);
            }
        } else if (cmd.rfind("DEVICE", 0) == 0) {
            std::string devId = cmd.size() > 7 ? cmd.substr(7) : "";
            bindEndpoint(devId);
        }
    }

    stopMonitor.store(true);
    if (hChangedEvent) SetEvent(hChangedEvent);
    if (devChangeThread.joinable()) devChangeThread.join();
    pEnum->UnregisterEndpointNotificationCallback(pDevWatcher);
    if (hChangedEvent) CloseHandle(hChangedEvent);
    pDevWatcher->Release();

    {
        std::lock_guard<std::mutex> lock(volMutex);
        if (pEndpointVol) {
            pEndpointVol->UnregisterControlChangeNotify(pWatcher);
            pEndpointVol->Release();
        }
        if (pDevice) pDevice->Release();
    }
    pWatcher->Release();
    pEnum->Release();
    CoUninitialize();
    return 0;
}

std::string ExtractJsonStringField(const std::string& json, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos = json.find('"', pos + 1);
    if (pos == std::string::npos) return "";
    ++pos;
    std::string out;
    while (pos < json.size()) {
        const char c = json[pos++];
        if (c == '"') break;
        if (c == '\\' && pos < json.size()) {
            const char esc = json[pos++];
            switch (esc) {
                case '\\': out.push_back('\\'); break;
                case '"': out.push_back('"'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                default: out.push_back(esc); break;
            }
        } else {
            out.push_back(c);
        }
    }
    return out;
}

double ExtractJsonNumberField(const std::string& json, const std::string& key, double fallback) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return fallback;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return fallback;
    ++pos;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
    if (pos >= json.size()) return fallback;
    char* endPtr = nullptr;
    const double val = std::strtod(json.c_str() + pos, &endPtr);
    if (endPtr == json.c_str() + pos || !std::isfinite(val)) return fallback;
    return val;
}

bool ExtractJsonBoolField(const std::string& json, const std::string& key, bool fallback) {
    const std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return fallback;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return fallback;
    ++pos;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) ++pos;
    if (json.compare(pos, 4, "true") == 0) return true;
    if (json.compare(pos, 5, "false") == 0) return false;
    return fallback;
}

size_t ReadAlignedBytesFromPipe(HANDLE hPipe, std::vector<uint8_t>& carry, uint8_t* outRaw, size_t maxFrames, size_t frameBytes) {
    if (hPipe == INVALID_HANDLE_VALUE || maxFrames == 0 || frameBytes == 0) return 0;
    const size_t wantedBytes = maxFrames * frameBytes;
    const size_t carryCount = carry.size();
    const size_t maxReadBytes = wantedBytes > carryCount ? (wantedBytes - carryCount) : frameBytes;
    std::vector<uint8_t> raw(carryCount + maxReadBytes);
    if (carryCount > 0) {
        std::memcpy(raw.data(), carry.data(), carryCount);
    }
    DWORD bytesRead = 0;
    const BOOL ok = ReadFile(hPipe, raw.data() + carryCount, static_cast<DWORD>(maxReadBytes), &bytesRead, nullptr);
    const size_t totalBytes = carryCount + static_cast<size_t>(bytesRead);
    const size_t wholeFrames = totalBytes / frameBytes;
    const size_t usedBytes = wholeFrames * frameBytes;
    if (wholeFrames > 0) {
        std::memcpy(outRaw, raw.data(), usedBytes);
    }
    const size_t rem = totalBytes - usedBytes;
    carry.resize(rem);
    if (rem > 0) {
        std::memcpy(carry.data(), raw.data() + usedBytes, rem);
    }
    if (!ok && bytesRead == 0) {
        carry.clear();
    }
    return wholeFrames;
}

size_t FrameBytesForInputFormat(InputWireFormat fmt, uint16_t channels) {
    switch (fmt) {
        case InputWireFormat::F64LE: return sizeof(double) * channels;
        case InputWireFormat::F32LE: return sizeof(float) * channels;
        case InputWireFormat::S32LE: return sizeof(int32_t) * channels;
    }
    return sizeof(int32_t) * channels;
}

void DecodeRawWireFrames(
    const uint8_t* raw,
    size_t frames,
    uint16_t channels,
    InputWireFormat fmt,
    int32_t* dstI32,
    double* dstF64) {
    const size_t count = frames * channels;
    if (count == 0) return;
    if (fmt == InputWireFormat::S32LE && dstI32) {
        std::memcpy(dstI32, raw, count * sizeof(int32_t));
    } else if (fmt == InputWireFormat::F64LE && dstF64) {
        std::memcpy(dstF64, raw, count * sizeof(double));
    } else if (fmt == InputWireFormat::F32LE && dstF64) {
        const float* fSrc = reinterpret_cast<const float*>(raw);
        for (size_t i = 0; i < count; ++i) {
            dstF64[i] = static_cast<double>(fSrc[i]);
        }
    }
}

void EmitSilencePreRoll(
    IAudioOutputBackend& backend,
    uint32_t preRollMs,
    uint32_t sampleRate,
    uint16_t channels,
    uint32_t blockAlign,
    bool isDop,
    WireSampleFormat wireFmt,
    std::vector<int32_t>& scratchI32) {
    if (preRollMs == 0 || sampleRate == 0) return;
    const uint32_t totalFrames = static_cast<uint32_t>((static_cast<uint64_t>(sampleRate) * preRollMs + 999ULL) / 1000ULL);
    uint32_t written = 0;
    uint32_t ftw = 0;
    bool timedOut = false;
    while (written < totalFrames && backend.WaitNextBuffer(250, ftw, timedOut)) {
        if (timedOut || ftw == 0) continue;
        const uint32_t chunk = std::min(ftw, totalFrames - written);
        BYTE* pData = nullptr;
        if (!backend.AcquireBuffer(chunk, &pData) || !pData) break;
        if (isDop) {
            if (scratchI32.size() < static_cast<size_t>(chunk) * channels) {
                scratchI32.resize(static_cast<size_t>(chunk) * channels);
            }
            for (uint32_t f = 0; f < chunk; ++f) {
                const int32_t muteWord = static_cast<int32_t>(PackDopWord24(f, 0x69u, 0x69u));
                for (uint16_t ch = 0; ch < channels; ++ch) {
                    scratchI32[static_cast<size_t>(f) * channels + ch] = muteWord;
                }
            }
            float dummyRing[FFT_N] = {};
            size_t dummyPos = 0;
            TelemetryFrameStats dummyStats{};
            WriteDopFrames(pData, scratchI32.data(), chunk, channels, wireFmt, dummyRing, dummyPos, dummyStats);
            backend.ReleaseBuffer(chunk, 0);
        } else {
            std::memset(pData, 0, static_cast<size_t>(chunk) * blockAlign);
            backend.ReleaseBuffer(chunk, AUDCLNT_BUFFERFLAGS_SILENT);
        }
        written += chunk;
    }
}

} // namespace

int main(int argc, char** argv) {
    const EngineOptions opts = ParseArgs(argc, argv);

    if (opts.listDevices) {
        return ListAudioDevices();
    }
    if (opts.listAsioDevices) {
        return ListAsioDevices();
    }
    if (!opts.listSacdIso.empty()) {
        return ListSacdIso(opts.listSacdIso);
    }
    if (!opts.extractSacdIso.empty()) {
        return ExtractSacdTrackToStdout(opts.extractSacdIso, opts.sacdArea, opts.sacdTrack);
    }
    if (opts.probeCaps) {
        return ProbeDeviceCaps(opts.deviceId, opts.channels);
    }
    if (opts.volumeMonitor) {
        return RunVolumeMonitor(opts.deviceId);
    }
    if (!opts.testDopFile.empty()) {
        return RunDopSelfTest(opts.testDopFile);
    }
    if (opts.selfTest) {
        return RunSelfTest();
    }

    const bool hasDsdFile = !opts.dopFile.empty();
    bool activeUseAsio = opts.asio;
    bool activeIsRawDsd = activeUseAsio && opts.rawDsd && hasDsdFile;
    bool activeIsDop = hasDsdFile && !activeIsRawDsd;
    std::unique_ptr<DopStreamReader> dopReader = std::make_unique<DopStreamReader>();
    uint32_t activeRate = opts.sampleRate;
    uint32_t activeDsdClockRate = 0;
    uint16_t activeChannels = opts.channels;
    InputWireFormat activeInFmt = (activeIsDop || activeIsRawDsd) ? InputWireFormat::S32LE : opts.inFmt;
    uint16_t activeSrcBits = opts.srcBits;
    bool activeExclusivePref = opts.exclusive;
    bool activePushMode = opts.pushMode;
    uint32_t activeBufferMs = opts.bufferMs;

    if (hasDsdFile) {
        if (!activeUseAsio && !opts.exclusive) {
            EmitJsonLine("{\"event\":\"dop_unsupported\",\"reason\":\"DoP v1.1 requires WASAPI Exclusive Mode\"}");
            return 10;
        }
        std::string dopErr;
        if (!dopReader->Open(opts.dopFile, opts.seekSec, dopErr, activeIsRawDsd)) {
            EmitJsonLine("{\"event\":\"dop_unsupported\",\"reason\":\"" + EscapeJson(dopErr) + "\"}");
            return 10;
        }
        activeDsdClockRate = dopReader->DsdSampleRate();
        activeRate = activeIsRawDsd ? (activeDsdClockRate / 8u) : dopReader->CarrierRate();
        activeChannels = dopReader->Channels();
    } else {
        _setmode(_fileno(stdin), _O_BINARY);
    }

    std::unique_ptr<IAudioOutputBackend> backendOwner;
    if (activeUseAsio) {
        backendOwner = std::make_unique<AsioOutputBackend>();
    } else {
        backendOwner = std::make_unique<WasapiOutputBackend>();
    }
    IAudioOutputBackend& outBackend = *backendOwner;

    OutputStreamSpec streamSpec{};
    streamSpec.sampleRate = activeIsRawDsd ? activeDsdClockRate : activeRate;
    streamSpec.channels = activeChannels;
    streamSpec.exclusive = activeExclusivePref;
    streamSpec.isDop = activeIsDop;
    streamSpec.usePushMode = activePushMode;
    streamSpec.useAsio = activeUseAsio;
    streamSpec.isRawDsd = activeIsRawDsd;
    streamSpec.bufferMs = activeBufferMs;
    streamSpec.preRollMs = opts.preRollMs;
    streamSpec.deviceId = opts.deviceId;
    streamSpec.asioDriver = opts.asioDriver;
    streamSpec.dsdLabel = hasDsdFile ? dopReader->DsdLabel() : "";

    OutputOpenResult openRes = outBackend.Open(streamSpec);
    if (!openRes.ok) {
        if (openRes.dopUnsupported) {
            EmitJsonLine("{\"event\":\"dop_unsupported\",\"reason\":\"" + EscapeJson(openRes.dopRejectReason) + "\"}");
            return 10;
        }
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + openRes.errorHresult + "\",\"message\":\"" + EscapeJson(openRes.errorMessage) + "\"}");
        return openRes.errorExitCode;
    }

    bool activeExclusive = openRes.activeExclusive;
    bool activeDsdMsbFirst = openRes.dsdMsbFirst;
    WireSampleFormat wireFmt = openRes.wireFmt;
    WAVEFORMATEXTENSIBLE chosenWfx = openRes.chosenWfx;
    UINT32 bufferFrameCount = openRes.bufferFrameCount;
    std::string deviceName = openRes.deviceName;

    DspConfigSnapshot initialDsp = ParseDspSpec(opts.dspSpec);
    if (!opts.peqSpec.empty()) initialDsp.peq = ParsePeqSpec(opts.peqSpec);
    if (opts.limiterEnabled) initialDsp.limiter = true;

    vanta_convolver::ConvolverHost64 convolverHost;
    std::mutex convolverLoadMutex;
    std::string activeConvolverPath;
    if (!opts.convolverIrPath.empty() && !activeIsDop && !activeIsRawDsd) {
        std::string irErr;
        size_t irTaps = 0;
        const std::wstring wIr = Utf8ToWide(opts.convolverIrPath);
        if (convolverHost.LoadFromFile(opts.convolverIrPath, chosenWfx.Format.nSamplesPerSec, opts.convolverWetPct / 100.0, wIr, irErr, &irTaps)) {
            activeConvolverPath = opts.convolverIrPath;
        }
    }

    auto computeSignalState = [&](const DspConfigSnapshot& cfg, float gainVal, InputWireFormat inFmt, uint16_t srcBits, bool isDopNow, bool isRawDsdNow, WireSampleFormat outFmt) {
        if (isRawDsdNow) return true;
        const bool needs16Dither = (outFmt == WireSampleFormat::Pcm16) && (inFmt != InputWireFormat::S32LE || srcBits > 16);
        return !isDopNow &&
            inFmt == InputWireFormat::S32LE &&
            !cfg.HasEqOrTone() &&
            !convolverHost.IsActive() &&
            !cfg.limiter &&
            std::fabs(static_cast<double>(gainVal) - 1.0) < 1e-6 &&
            outFmt != WireSampleFormat::Float32 &&
            !needs16Dither;
    };

    auto emitReadyEvent = [&](const std::string& dsdLabelNow, uint64_t xruns) {
        const bool bitExactNow = computeSignalState(initialDsp, opts.initialGain, activeInFmt, activeSrcBits, activeIsDop, activeIsRawDsd, wireFmt);
        std::string modeStr = "shared";
        if (activeIsRawDsd) modeStr = "asio_dsd_raw";
        else if (activeUseAsio) modeStr = "asio";
        else if (activeIsDop) modeStr = "dop_exclusive";
        else if (activeExclusive) modeStr = "exclusive";

        const uint32_t reportedRate = activeIsRawDsd ? activeDsdClockRate : chosenWfx.Format.nSamplesPerSec;
        std::string rJson = "{\"event\":\"ready\",\"mode\":\"" + modeStr + "\"";
        if (activeIsDop || activeIsRawDsd) {
            rJson += ",\"dsdRate\":\"" + EscapeJson(dsdLabelNow) + "\"";
        }
        rJson += ",\"sampleRate\":" + std::to_string(reportedRate) +
            ",\"bitsPerSample\":" + std::to_string(activeIsRawDsd ? 1 : (activeIsDop ? 24 : chosenWfx.Format.wBitsPerSample)) +
            ",\"validBits\":" + std::to_string(activeIsRawDsd ? 1 : chosenWfx.Samples.wValidBitsPerSample) +
            ",\"channels\":" + std::to_string(chosenWfx.Format.nChannels) +
            ",\"bufferFrames\":" + std::to_string(bufferFrameCount) +
            ",\"pushMode\":" + std::string(activePushMode ? "true" : "false") +
            ",\"inFmt\":\"" + InputWireFormatName(activeInFmt) + "\"" +
            ",\"srcBits\":" + std::to_string(activeIsRawDsd ? 1 : activeSrcBits) +
            ",\"xrunCount\":" + std::to_string(xruns) +
            ",\"bitExact\":" + std::string(bitExactNow ? "true" : "false") +
            ",\"eqActive\":" + std::string(initialDsp.HasEqActive() ? "true" : "false") +
            ",\"peqActive\":" + std::string(initialDsp.peq.HasActive() ? "true" : "false") +
            ",\"convolverActive\":" + std::string(convolverHost.IsActive() ? "true" : "false") +
            ",\"bass\":" + std::string(initialDsp.bass ? "true" : "false") +
            ",\"crossfeed\":" + std::string(initialDsp.crossfeed ? "true" : "false") +
            ",\"limiter\":" + std::string(initialDsp.limiter ? "true" : "false") +
            ",\"signalMode\":\"" + std::string(activeIsRawDsd ? "asio_dsd_raw" : (activeIsDop ? "dop_exclusive" : (bitExactNow ? "bit_exact" : "purepath_64"))) + "\"" +
            ",\"deviceName\":\"" + EscapeJson(deviceName) + "\"}";
        EmitJsonLine(rJson);
    };
    emitReadyEvent(hasDsdFile ? dopReader->DsdLabel() : "", 0);

    std::atomic<bool> stopRequested{false};
    std::atomic<bool> paused{false};
    std::atomic<bool> stdinEof{false};
    std::atomic<bool> switchPending{false};
    std::atomic<float> linearGain{opts.initialGain};
    std::atomic<uint64_t> framesPlayed{0};
    std::atomic<uint64_t> xrunCount{0};
    std::atomic<uint32_t> renderRateAtomic{activeRate};

    std::mutex dspConfigMutex;
    DspConfigSnapshot stagedDspConfig = initialDsp;
    std::atomic<uint64_t> dspConfigSeq{1};

    auto emitDspStateEvent = [&](const DspConfigSnapshot& cfg, float gainVal) {
        const bool bitExactNow = computeSignalState(cfg, gainVal, activeInFmt, activeSrcBits, activeIsDop, activeIsRawDsd, wireFmt);
        const std::string msg = std::string("{\"event\":\"dsp_state\",\"bitExact\":") +
            (bitExactNow ? "true" : "false") +
            ",\"eqActive\":" + (cfg.HasEqActive() ? "true" : "false") +
            ",\"peqActive\":" + (cfg.peq.HasActive() ? "true" : "false") +
            ",\"convolverActive\":" + (convolverHost.IsActive() ? "true" : "false") +
            ",\"bass\":" + (cfg.bass ? "true" : "false") +
            ",\"crossfeed\":" + (cfg.crossfeed ? "true" : "false") +
            ",\"limiter\":" + (cfg.limiter ? "true" : "false") +
            ",\"signalMode\":\"" + (activeIsDop ? "dop_exclusive" : (bitExactNow ? "bit_exact" : "purepath_64")) + "\"}";
        EmitJsonLine(msg);
    };

    struct TrackBoundary {
        uint64_t totalRingFramePos = 0;
        uint64_t seq = 0;
        uint16_t srcBits = 24;
        float linearGain = 1.0f;
    };
    struct QueuedStreamRequest {
        bool active = false;
        uint64_t seq = 0;
        uint64_t gen = 0;
        bool isDop = false;
        std::string dopFile;
        double seekSec = 0.0;
        std::string pipeName;
        uint32_t sampleRate = 48000;
        uint16_t channels = 2;
        InputWireFormat inFmt = InputWireFormat::S32LE;
        uint16_t srcBits = 24;
        bool exclusive = true;
        bool pushMode = false;
        uint32_t bufferMs = 0;
        uint32_t preRollMs = 0;
        float linearGain = 1.0f;
        HANDLE hPipe = INVALID_HANDLE_VALUE;
        bool pipeEof = false;
        std::vector<int32_t> preloadedI32;
        std::vector<double> preloadedF64;
        size_t preloadedFrames = 0;
        std::vector<uint8_t> carryBytes;
        std::unique_ptr<DopStreamReader> preloadedDop;
    };

    std::mutex queueMutex;
    QueuedStreamRequest queuedStream;
    std::atomic<uint64_t> preloadGen{0};
    std::atomic<bool> preloadStopHint{false};
    std::thread preloadThread;
    std::mutex boundaryMutex;
    std::vector<TrackBoundary> trackBoundaries;
    std::mutex switchMutex;
    QueuedStreamRequest pendingSwitchReq;
    HANDLE hSwitchDoneEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    auto closeQueuedReqResources = [](QueuedStreamRequest& req) {
        if (req.hPipe != INVALID_HANDLE_VALUE) {
            CloseHandle(req.hPipe);
            req.hPipe = INVALID_HANDLE_VALUE;
        }
        req.preloadedDop.reset();
        req.preloadedI32.clear();
        req.preloadedF64.clear();
        req.carryBytes.clear();
        req.preloadedFrames = 0;
        req.active = false;
    };

    auto cancelQueuedStream = [&]() {
        preloadGen.fetch_add(1);
        preloadStopHint.store(true);
        if (preloadThread.joinable()) preloadThread.join();
        preloadStopHint.store(false);
        std::lock_guard<std::mutex> qlk(queueMutex);
        closeQueuedReqResources(queuedStream);
    };

    const size_t initRingFrames = (activeRate > 384000u) ? 524288u : RING_FRAMES;
    FrameRingBuffer<int32_t> ringI32((!activeIsRawDsd && activeInFmt == InputWireFormat::S32LE) ? initRingFrames : 64u, activeChannels);
    FrameRingBuffer<double> ringF64((!activeIsRawDsd && activeInFmt != InputWireFormat::S32LE) ? initRingFrames : 64u, activeChannels);
    FrameRingBuffer<uint8_t> ringRawDsd(activeIsRawDsd ? 524288u : 64u, activeChannels);

    struct PreloadParams {
        uint64_t gen = 0;
        bool isDop = false;
        std::string dopFile;
        double seekSec = 0.0;
        std::string pipeName;
        uint32_t sampleRate = 48000;
        uint16_t channels = 2;
        InputWireFormat inFmt = InputWireFormat::S32LE;
    };

    auto startPreloadForQueued = [&](PreloadParams reqSnapshot) {
        const uint64_t myGen = reqSnapshot.gen;
        preloadThread = std::thread([&, reqSnapshot, myGen]() mutable {
            if (reqSnapshot.isDop) {
                auto dReader = std::make_unique<DopStreamReader>();
                std::string dErr;
                if (dReader->Open(reqSnapshot.dopFile, reqSnapshot.seekSec, dErr)) {
                    const uint32_t dRate = dReader->CarrierRate();
                    const uint16_t dCh = dReader->Channels();
                    std::lock_guard<std::mutex> qlk(queueMutex);
                    if (queuedStream.gen == myGen && queuedStream.active) {
                        queuedStream.sampleRate = dRate;
                        queuedStream.channels = dCh;
                        queuedStream.preloadedDop = std::move(dReader);
                    }
                }
                return;
            }

            HANDLE hQPipe = INVALID_HANDLE_VALUE;
            for (int attempt = 0; attempt < 40 && !stopRequested.load() && !preloadStopHint.load() && preloadGen.load() == myGen; ++attempt) {
                hQPipe = CreateFileA(reqSnapshot.pipeName.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
                if (hQPipe != INVALID_HANDLE_VALUE) break;
                Sleep(15);
            }
            if (hQPipe == INVALID_HANDLE_VALUE) return;

            const size_t maxPreloadFrames = static_cast<size_t>(reqSnapshot.sampleRate) * 2;
            const size_t frameBytesLocal = FrameBytesForInputFormat(reqSnapshot.inFmt, reqSnapshot.channels);
            std::vector<int32_t> bufI32;
            std::vector<double> bufF64;
            std::vector<uint8_t> carry;
            std::vector<uint8_t> rawChunk(4096 * frameBytesLocal);
            std::vector<int32_t> decI32(4096 * reqSnapshot.channels);
            std::vector<double> decF64(4096 * reqSnapshot.channels);
            size_t totalPreFrames = 0;
            bool pipeEofLocal = false;

            while (totalPreFrames < maxPreloadFrames && !stopRequested.load() && !preloadStopHint.load() && preloadGen.load() == myGen) {
                const size_t got = ReadAlignedBytesFromPipe(hQPipe, carry, rawChunk.data(), 4096, frameBytesLocal);
                if (got == 0) {
                    pipeEofLocal = true;
                    break;
                }
                if (reqSnapshot.inFmt == InputWireFormat::S32LE) {
                    DecodeRawWireFrames(rawChunk.data(), got, reqSnapshot.channels, reqSnapshot.inFmt, decI32.data(), nullptr);
                    bufI32.insert(bufI32.end(), decI32.begin(), decI32.begin() + got * reqSnapshot.channels);
                } else {
                    DecodeRawWireFrames(rawChunk.data(), got, reqSnapshot.channels, reqSnapshot.inFmt, nullptr, decF64.data());
                    bufF64.insert(bufF64.end(), decF64.begin(), decF64.begin() + got * reqSnapshot.channels);
                }
                totalPreFrames += got;
            }

            std::lock_guard<std::mutex> qlk(queueMutex);
            if (queuedStream.gen == myGen && queuedStream.active) {
                queuedStream.hPipe = hQPipe;
                queuedStream.pipeEof = pipeEofLocal;
                queuedStream.preloadedI32 = std::move(bufI32);
                queuedStream.preloadedF64 = std::move(bufF64);
                queuedStream.preloadedFrames = totalPreFrames;
                queuedStream.carryBytes = std::move(carry);
            } else {
                CloseHandle(hQPipe);
            }
        });
    };

    // Control named-pipe thread (zero firewall prompts, <0.1ms Pause/Resume/Gain/DSP/Gapless/Stop)
    std::thread ctrlThread;
    if (!opts.ctrlPipeName.empty()) {
        ctrlThread = std::thread([&]() {
            HANDLE hPipe = INVALID_HANDLE_VALUE;
            for (int attempt = 0; attempt < 25 && !stopRequested.load(); ++attempt) {
                hPipe = CreateFileA(opts.ctrlPipeName.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
                if (hPipe != INVALID_HANDLE_VALUE) break;
                Sleep(20);
            }
            if (hPipe == INVALID_HANDLE_VALUE) return;

            std::string pending;
            char buf[2048];
            DWORD bytesRead = 0;
            while (!stopRequested.load() && ReadFile(hPipe, buf, sizeof(buf), &bytesRead, nullptr) && bytesRead > 0) {
                pending.append(buf, bytesRead);
                size_t nl;
                while ((nl = pending.find('\n')) != std::string::npos) {
                    std::string cmd = pending.substr(0, nl);
                    pending.erase(0, nl + 1);
                    if (!cmd.empty() && cmd.back() == '\r') cmd.pop_back();
                    if (cmd == "PAUSE") {
                        paused.store(true);
                        const uint32_t curRate = renderRateAtomic.load();
                        const uint64_t posMs = (framesPlayed.load() * 1000ULL) / (curRate > 0 ? curRate : 48000u);
                        EmitJsonLine("{\"event\":\"paused\",\"positionMs\":" + std::to_string(posMs) + ",\"xrunCount\":" + std::to_string(xrunCount.load()) + "}");
                    } else if (cmd == "RESUME") {
                        paused.store(false);
                        const uint32_t curRate = renderRateAtomic.load();
                        const uint64_t posMs = (framesPlayed.load() * 1000ULL) / (curRate > 0 ? curRate : 48000u);
                        EmitJsonLine("{\"event\":\"resumed\",\"positionMs\":" + std::to_string(posMs) + ",\"xrunCount\":" + std::to_string(xrunCount.load()) + "}");
                    } else if (cmd == "STOP") {
                        stopRequested.store(true);
                    } else if (cmd == "CLEAR_QUEUE") {
                        cancelQueuedStream();
                    } else if (cmd == "LIMITER ON") {
                        DspConfigSnapshot snap;
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            stagedDspConfig.limiter = true;
                            snap = stagedDspConfig;
                        }
                        dspConfigSeq.fetch_add(1);
                        emitDspStateEvent(snap, linearGain.load());
                    } else if (cmd == "LIMITER OFF") {
                        DspConfigSnapshot snap;
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            stagedDspConfig.limiter = false;
                            snap = stagedDspConfig;
                        }
                        dspConfigSeq.fetch_add(1);
                        emitDspStateEvent(snap, linearGain.load());
                    } else if (cmd.rfind("DSP ", 0) == 0) {
                        DspConfigSnapshot nextCfg = ParseDspSpec(cmd.substr(4));
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            nextCfg.peq = stagedDspConfig.peq;
                            stagedDspConfig = nextCfg;
                        }
                        dspConfigSeq.fetch_add(1);
                        emitDspStateEvent(nextCfg, linearGain.load());
                    } else if (cmd == "PEQ_OFF") {
                        DspConfigSnapshot snap;
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            stagedDspConfig.peq = PeqConfigSnapshot{};
                            snap = stagedDspConfig;
                        }
                        dspConfigSeq.fetch_add(1);
                        emitDspStateEvent(snap, linearGain.load());
                    } else if (cmd.rfind("PEQ_SPEC ", 0) == 0) {
                        PeqConfigSnapshot nextPeq = ParsePeqSpec(cmd.substr(9));
                        DspConfigSnapshot snap;
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            stagedDspConfig.peq = nextPeq;
                            snap = stagedDspConfig;
                        }
                        dspConfigSeq.fetch_add(1);
                        emitDspStateEvent(snap, linearGain.load());
                    } else if (cmd == "CONVOLVER_OFF") {
                        {
                            std::lock_guard<std::mutex> clk(convolverLoadMutex);
                            activeConvolverPath.clear();
                            convolverHost.Disable();
                        }
                        DspConfigSnapshot snap;
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            snap = stagedDspConfig;
                        }
                        EmitJsonLine("{\"event\":\"convolver_state\",\"active\":false}");
                        emitDspStateEvent(snap, linearGain.load());
                    } else if (cmd.rfind("CONVOLVER_WET ", 0) == 0) {
                        const double wPct = ClampDouble(std::strtod(cmd.c_str() + 14, nullptr), 0.0, 100.0);
                        convolverHost.SetWetMix(wPct / 100.0);
                    } else if (cmd.rfind("CONVOLVER_LOAD ", 0) == 0) {
                        const std::string arg = cmd.substr(15);
                        const size_t sep = arg.find('|');
                        double wPct = 100.0;
                        std::string wavUtf8 = arg;
                        if (sep != std::string::npos) {
                            wPct = ClampDouble(std::strtod(arg.substr(0, sep).c_str(), nullptr), 0.0, 100.0);
                            wavUtf8 = arg.substr(sep + 1);
                        }
                        std::string cErr;
                        size_t irTaps = 0;
                        bool loadedOk = false;
                        const uint32_t curRate = renderRateAtomic.load();
                        const std::wstring wPath = Utf8ToWide(wavUtf8);
                        {
                            std::lock_guard<std::mutex> clk(convolverLoadMutex);
                            loadedOk = convolverHost.LoadFromFile(wavUtf8, curRate > 0 ? curRate : 48000u, wPct / 100.0, wPath, cErr, &irTaps);
                            if (loadedOk) activeConvolverPath = wavUtf8;
                        }
                        if (loadedOk) {
                            EmitJsonLine("{\"event\":\"convolver_state\",\"active\":true,\"taps\":" + std::to_string(irTaps) + ",\"wetPct\":" + std::to_string(static_cast<int>(std::llround(wPct))) + "}");
                        } else {
                            EmitJsonLine("{\"event\":\"convolver_state\",\"active\":false,\"error\":\"" + EscapeJson(cErr) + "\"}");
                        }
                        DspConfigSnapshot snap;
                        {
                            std::lock_guard<std::mutex> lk(dspConfigMutex);
                            snap = stagedDspConfig;
                        }
                        emitDspStateEvent(snap, linearGain.load());
                    } else if (cmd.rfind("GAIN ", 0) == 0) {
                        float g = std::strtof(cmd.c_str() + 5, nullptr);
                        if (g >= 0.0f && g <= 2.5f) {
                            linearGain.store(g);
                            DspConfigSnapshot snap;
                            {
                                std::lock_guard<std::mutex> lk(dspConfigMutex);
                                snap = stagedDspConfig;
                            }
                            emitDspStateEvent(snap, g);
                        }
                    } else if (cmd.rfind("QUEUE_PCM ", 0) == 0) {
                        const std::string rest = cmd.substr(10);
                        const size_t sp = rest.find(' ');
                        if (sp != std::string::npos) {
                            const std::string qPipe = rest.substr(0, sp);
                            const uint64_t qSeq = std::strtoull(rest.c_str() + sp + 1, nullptr, 10);
                            cancelQueuedStream();
                            const uint64_t myGen = preloadGen.fetch_add(1) + 1;
                            QueuedStreamRequest snap{};
                            snap.active = true;
                            snap.seq = qSeq;
                            snap.gen = myGen;
                            snap.pipeName = qPipe;
                            snap.sampleRate = activeRate;
                            snap.channels = activeChannels;
                            snap.inFmt = activeInFmt;
                            snap.srcBits = activeSrcBits;
                            snap.exclusive = activeExclusivePref;
                            snap.pushMode = activePushMode;
                            snap.bufferMs = activeBufferMs;
                            snap.linearGain = linearGain.load();
                            PreloadParams pParams{myGen, false, "", 0.0, qPipe, activeRate, activeChannels, activeInFmt};
                            {
                                std::lock_guard<std::mutex> qlk(queueMutex);
                                queuedStream = std::move(snap);
                            }
                            startPreloadForQueued(std::move(pParams));
                        }
                    } else if (cmd.rfind("QUEUE_NEXT_JSON ", 0) == 0) {
                        const std::string jsonBody = cmd.substr(16);
                        cancelQueuedStream();
                        const uint64_t myGen = preloadGen.fetch_add(1) + 1;
                        QueuedStreamRequest snap{};
                        snap.active = true;
                        snap.gen = myGen;
                        snap.seq = static_cast<uint64_t>(std::max(0.0, ExtractJsonNumberField(jsonBody, "seq", 0.0)));
                        snap.isDop = ExtractJsonBoolField(jsonBody, "isDop", false);
                        snap.dopFile = ExtractJsonStringField(jsonBody, "dopFile");
                        snap.seekSec = std::max(0.0, ExtractJsonNumberField(jsonBody, "seekSec", 0.0));
                        snap.pipeName = ExtractJsonStringField(jsonBody, "pipe");
                        snap.sampleRate = static_cast<uint32_t>(ClampDouble(ExtractJsonNumberField(jsonBody, "rate", static_cast<double>(activeRate)), 8000.0, 768000.0));
                        snap.channels = static_cast<uint16_t>(ClampDouble(ExtractJsonNumberField(jsonBody, "ch", static_cast<double>(activeChannels)), 1.0, 8.0));
                        snap.inFmt = snap.isDop ? InputWireFormat::S32LE : ParseInputWireFormat(ExtractJsonStringField(jsonBody, "inFmt"));
                        snap.srcBits = static_cast<uint16_t>(ClampDouble(ExtractJsonNumberField(jsonBody, "srcBits", 24.0), 8.0, 64.0));
                        snap.exclusive = ExtractJsonBoolField(jsonBody, "exclusive", activeExclusivePref);
                        snap.pushMode = ExtractJsonBoolField(jsonBody, "push", activePushMode);
                        snap.bufferMs = static_cast<uint32_t>(ClampDouble(ExtractJsonNumberField(jsonBody, "bufferMs", static_cast<double>(activeBufferMs)), 0.0, 200.0));
                        snap.preRollMs = static_cast<uint32_t>(ClampDouble(ExtractJsonNumberField(jsonBody, "preRollMs", 0.0), 0.0, 500.0));
                        snap.linearGain = static_cast<float>(ClampDouble(ExtractJsonNumberField(jsonBody, "gain", static_cast<double>(linearGain.load())), 0.0, 4.0));
                        if ((!snap.isDop && !snap.pipeName.empty()) || (snap.isDop && !snap.dopFile.empty())) {
                            PreloadParams pParams{myGen, snap.isDop, snap.dopFile, snap.seekSec, snap.pipeName, snap.sampleRate, snap.channels, snap.inFmt};
                            {
                                std::lock_guard<std::mutex> qlk(queueMutex);
                                queuedStream = std::move(snap);
                            }
                            startPreloadForQueued(std::move(pParams));
                        }
                    }
                }
            }
            CloseHandle(hPipe);
        });
    }

    // Stream producer thread (direct DSF/DFF DoP packetizer or stdin + same/cross-rate queued streams)
    HANDLE hActivePipe = INVALID_HANDLE_VALUE;
    std::vector<uint8_t> activePipeCarry;
    uint64_t totalFramesWrittenToRing = 0;

    std::thread readerThread([&]() {
        uint32_t rRate = activeRate;
        uint16_t rCh = activeChannels;
        InputWireFormat rInFmt = activeInFmt;
        bool rIsDop = activeIsDop;
        bool rIsRawDsd = activeIsRawDsd;
        const size_t chunkFrames = 4096;
        std::vector<uint8_t> rawTemp(chunkFrames * sizeof(double) * MAX_AUDIO_CHANNELS);
        std::vector<int32_t> tempI32(chunkFrames * MAX_AUDIO_CHANNELS);
        std::vector<double> tempF64(chunkFrames * MAX_AUDIO_CHANNELS);

        auto pushRawDsdToRing = [&](const uint8_t* ptr, size_t count) {
            size_t written = 0;
            while (written < count && !stopRequested.load()) {
                size_t n = ringRawDsd.Write(ptr + written * rCh, count - written);
                written += n;
                totalFramesWrittenToRing += n;
                if (written < count) Sleep(2);
            }
        };
        auto pushI32ToRing = [&](const int32_t* ptr, size_t count) {
            size_t written = 0;
            while (written < count && !stopRequested.load()) {
                size_t n = ringI32.Write(ptr + written * rCh, count - written);
                written += n;
                totalFramesWrittenToRing += n;
                if (written < count) Sleep(2);
            }
        };
        auto pushF64ToRing = [&](const double* ptr, size_t count) {
            size_t written = 0;
            while (written < count && !stopRequested.load()) {
                size_t n = ringF64.Write(ptr + written * rCh, count - written);
                written += n;
                totalFramesWrittenToRing += n;
                if (written < count) Sleep(2);
            }
        };

        while (!stopRequested.load()) {
            const size_t space = rIsRawDsd
                ? ringRawDsd.AvailableToWrite()
                : ((rInFmt == InputWireFormat::S32LE) ? ringI32.AvailableToWrite() : ringF64.AvailableToWrite());
            if (space < chunkFrames) {
                Sleep(4);
                continue;
            }
            const size_t fBytes = FrameBytesForInputFormat(rInFmt, rCh);
            size_t framesRead = 0;
            if (rIsRawDsd && dopReader) {
                framesRead = dopReader->ReadRawDsdOctetFrames(rawTemp.data(), chunkFrames, activeDsdMsbFirst);
            } else if (rIsDop && dopReader) {
                framesRead = dopReader->ReadCarrierFrames(tempI32.data(), chunkFrames);
            } else if (hActivePipe != INVALID_HANDLE_VALUE) {
                framesRead = ReadAlignedBytesFromPipe(hActivePipe, activePipeCarry, rawTemp.data(), chunkFrames, fBytes);
                if (framesRead > 0) {
                    DecodeRawWireFrames(rawTemp.data(), framesRead, rCh, rInFmt, tempI32.data(), tempF64.data());
                }
            } else {
                framesRead = std::fread(rawTemp.data(), fBytes, chunkFrames, stdin);
                if (framesRead > 0) {
                    DecodeRawWireFrames(rawTemp.data(), framesRead, rCh, rInFmt, tempI32.data(), tempF64.data());
                }
            }

            if (framesRead == 0) {
                if (hActivePipe != INVALID_HANDLE_VALUE) {
                    CloseHandle(hActivePipe);
                    hActivePipe = INVALID_HANDLE_VALUE;
                    activePipeCarry.clear();
                }

                QueuedStreamRequest nextReq{};
                {
                    bool shouldJoinPreloader = false;
                    {
                        std::lock_guard<std::mutex> qlk(queueMutex);
                        if (queuedStream.active) {
                            shouldJoinPreloader = true;
                            preloadStopHint.store(true);
                        }
                    }
                    if (shouldJoinPreloader && preloadThread.joinable()) {
                        preloadThread.join();
                    }
                    preloadStopHint.store(false);

                    std::lock_guard<std::mutex> qlk(queueMutex);
                    if (queuedStream.active &&
                        ((queuedStream.isDop && queuedStream.preloadedDop) ||
                         (!queuedStream.isDop && (queuedStream.preloadedFrames > 0 || queuedStream.hPipe != INVALID_HANDLE_VALUE)))) {
                        nextReq = std::move(queuedStream);
                        queuedStream = QueuedStreamRequest{};
                    }
                }

                if (!nextReq.active) {
                    stdinEof.store(true);
                    break;
                }

                const bool sameFormat = !rIsDop && !nextReq.isDop &&
                    nextReq.sampleRate == rRate &&
                    nextReq.channels == rCh &&
                    nextReq.inFmt == rInFmt &&
                    nextReq.exclusive == activeExclusivePref &&
                    nextReq.pushMode == activePushMode &&
                    nextReq.bufferMs == activeBufferMs;

                if (sameFormat) {
                    {
                        std::lock_guard<std::mutex> blk(boundaryMutex);
                        trackBoundaries.push_back(TrackBoundary{ totalFramesWrittenToRing, nextReq.seq, nextReq.srcBits, nextReq.linearGain });
                    }
                    if (nextReq.preloadedFrames > 0) {
                        if (rInFmt == InputWireFormat::S32LE) {
                            pushI32ToRing(nextReq.preloadedI32.data(), nextReq.preloadedFrames);
                        } else {
                            pushF64ToRing(nextReq.preloadedF64.data(), nextReq.preloadedFrames);
                        }
                    }
                    if (!nextReq.pipeEof && nextReq.hPipe != INVALID_HANDLE_VALUE) {
                        hActivePipe = nextReq.hPipe;
                        activePipeCarry = std::move(nextReq.carryBytes);
                        continue;
                    }
                    if (nextReq.hPipe != INVALID_HANDLE_VALUE) CloseHandle(nextReq.hPipe);
                    continue;
                }

                // Cross-format / DSD re-init transition inside persistent process
                if (hSwitchDoneEvent) ResetEvent(hSwitchDoneEvent);
                {
                    std::lock_guard<std::mutex> slk(switchMutex);
                    pendingSwitchReq = std::move(nextReq);
                }
                switchPending.store(true);
                while (!stopRequested.load()) {
                    if (hSwitchDoneEvent && WaitForSingleObject(hSwitchDoneEvent, 50) == WAIT_OBJECT_0) {
                        break;
                    }
                    if (!switchPending.load()) break;
                }
                if (stopRequested.load()) break;

                QueuedStreamRequest resumedReq{};
                {
                    std::lock_guard<std::mutex> slk(switchMutex);
                    resumedReq = std::move(pendingSwitchReq);
                    pendingSwitchReq = QueuedStreamRequest{};
                }
                if (!resumedReq.active) {
                    stdinEof.store(true);
                    break;
                }

                rRate = resumedReq.sampleRate;
                rCh = resumedReq.channels;
                rInFmt = resumedReq.inFmt;
                rIsDop = resumedReq.isDop;
                totalFramesWrittenToRing = 0;

                if (rIsDop) {
                    dopReader = std::move(resumedReq.preloadedDop);
                    continue;
                }
                dopReader.reset();
                if (resumedReq.preloadedFrames > 0) {
                    if (rInFmt == InputWireFormat::S32LE) {
                        pushI32ToRing(resumedReq.preloadedI32.data(), resumedReq.preloadedFrames);
                    } else {
                        pushF64ToRing(resumedReq.preloadedF64.data(), resumedReq.preloadedFrames);
                    }
                }
                if (!resumedReq.pipeEof && resumedReq.hPipe != INVALID_HANDLE_VALUE) {
                    hActivePipe = resumedReq.hPipe;
                    activePipeCarry = std::move(resumedReq.carryBytes);
                    continue;
                }
                if (resumedReq.hPipe != INVALID_HANDLE_VALUE) CloseHandle(resumedReq.hPipe);
                continue;
            }

            if (rIsRawDsd) {
                pushRawDsdToRing(rawTemp.data(), framesRead);
            } else if (rInFmt == InputWireFormat::S32LE) {
                pushI32ToRing(tempI32.data(), framesRead);
            } else {
                pushF64ToRing(tempF64.data(), framesRead);
            }
        }

        if (hActivePipe != INVALID_HANDLE_VALUE) {
            CloseHandle(hActivePipe);
            hActivePipe = INVALID_HANDLE_VALUE;
        }
    });

    // Wait briefly to prefill ring buffer so event/push render starts glitch-free
    auto ringAvailRead = [&]() -> size_t {
        if (activeIsRawDsd) return ringRawDsd.AvailableToRead();
        return (activeInFmt == InputWireFormat::S32LE) ? ringI32.AvailableToRead() : ringF64.AvailableToRead();
    };
    for (int waitMs = 0; waitMs < 400 && ringAvailRead() < bufferFrameCount * 2 && !stdinEof.load(); waitMs += 10) {
        Sleep(10);
    }

    DWORD taskIndex = 0;
    HANDLE hMmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    outBackend.PreFillSilence(bufferFrameCount, chosenWfx.Format.nBlockAlign);

    std::string startHresult;
    if (!outBackend.Start(startHresult)) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + startHresult + "\",\"message\":\"IAudioClient::Start failed\"}");
        stopRequested.store(true);
    }

    std::vector<int32_t> frameScratchI32(static_cast<size_t>(bufferFrameCount) * activeChannels);
    std::vector<double> frameScratchF64(static_cast<size_t>(bufferFrameCount) * activeChannels);
    std::vector<uint8_t> frameScratchRawDsd(static_cast<size_t>(bufferFrameCount) * activeChannels);
    if (!activeIsRawDsd) {
        EmitSilencePreRoll(outBackend, opts.preRollMs, activeRate, activeChannels, chosenWfx.Format.nBlockAlign, activeIsDop, wireFmt, frameScratchI32);
    }

    PurePathDspRack64 dspRack;
    dspRack.ApplyConfig(chosenWfx.Format.nSamplesPerSec, initialDsp);
    uint64_t seenDspSeq = dspConfigSeq.load();

    TruePeakLimiter64 truePeakLimiter;
    truePeakLimiter.Configure(chosenWfx.Format.nSamplesPerSec, -0.3);
    TpdfDitherShaper64 tpdfDither;

    uint64_t totalFramesRendered = 0;
    uint64_t currentTrackStartFrame = 0;
    float fftRing[FFT_N] = {};
    size_t fftWritePos = 0;
    TelemetryFrameStats frameStats{};
    AudioAnalysisMeters64 audioMeters;
    ULONGLONG lastTelemetryTick = GetTickCount64();

    while (!stopRequested.load()) {
        const uint64_t latestSeq = dspConfigSeq.load();
        if (latestSeq != seenDspSeq) {
            DspConfigSnapshot nextSnap;
            {
                std::lock_guard<std::mutex> lk(dspConfigMutex);
                nextSnap = stagedDspConfig;
            }
            dspRack.ApplyConfig(chosenWfx.Format.nSamplesPerSec, nextSnap);
            seenDspSeq = latestSeq;
        }
        uint32_t framesToWrite = 0;
        bool timedOut = false;
        if (!outBackend.WaitNextBuffer(500, framesToWrite, timedOut)) {
            break;
        }
        if (timedOut) {
            if (stdinEof.load() && ringAvailRead() == 0) break;
            continue;
        }

        if (framesToWrite == 0) continue;

        BYTE* pData = nullptr;
        if (!outBackend.AcquireBuffer(framesToWrite, &pData) || !pData) {
            if (outBackend.LastAcquireHResult() == AUDCLNT_E_BUFFER_OPERATION_PENDING) {
                xrunCount.fetch_add(1);
            }
            continue;
        }

        if (paused.load()) {
            if (activeIsRawDsd) {
                vanta_asio::AsioDriverHost::FillRawDsdSilence(pData, static_cast<size_t>(framesToWrite) * activeChannels);
                outBackend.ReleaseBuffer(framesToWrite, 0);
            } else if (activeIsDop) {
                if (frameScratchI32.size() < static_cast<size_t>(framesToWrite) * activeChannels) {
                    frameScratchI32.resize(static_cast<size_t>(framesToWrite) * activeChannels);
                }
                for (uint32_t f = 0; f < framesToWrite; ++f) {
                    const int32_t muteWord = static_cast<int32_t>(PackDopWord24(f, 0x69u, 0x69u));
                    for (uint16_t ch = 0; ch < activeChannels; ++ch) {
                        frameScratchI32[static_cast<size_t>(f) * activeChannels + ch] = muteWord;
                    }
                }
                size_t dummyPos = fftWritePos;
                TelemetryFrameStats dummyStats{};
                WriteDopFrames(pData, frameScratchI32.data(), framesToWrite, activeChannels, wireFmt, fftRing, dummyPos, dummyStats);
                outBackend.ReleaseBuffer(framesToWrite, 0);
            } else {
                std::memset(pData, 0, static_cast<size_t>(framesToWrite) * chosenWfx.Format.nBlockAlign);
                outBackend.ReleaseBuffer(framesToWrite, AUDCLNT_BUFFERFLAGS_SILENT);
            }
            continue;
        }

        size_t gotFrames = 0;
        if (activeIsRawDsd) {
            if (frameScratchRawDsd.size() < static_cast<size_t>(framesToWrite) * activeChannels) {
                frameScratchRawDsd.resize(static_cast<size_t>(framesToWrite) * activeChannels);
            }
            gotFrames = ringRawDsd.Read(frameScratchRawDsd.data(), framesToWrite);
        } else if (activeInFmt == InputWireFormat::S32LE) {
            if (frameScratchI32.size() < static_cast<size_t>(framesToWrite) * activeChannels) {
                frameScratchI32.resize(static_cast<size_t>(framesToWrite) * activeChannels);
            }
            gotFrames = ringI32.Read(frameScratchI32.data(), framesToWrite);
        } else {
            if (frameScratchF64.size() < static_cast<size_t>(framesToWrite) * activeChannels) {
                frameScratchF64.resize(static_cast<size_t>(framesToWrite) * activeChannels);
            }
            gotFrames = ringF64.Read(frameScratchF64.data(), framesToWrite);
        }

        if (gotFrames == 0) {
            std::memset(pData, 0, static_cast<size_t>(framesToWrite) * chosenWfx.Format.nBlockAlign);
            outBackend.ReleaseBuffer(framesToWrite, AUDCLNT_BUFFERFLAGS_SILENT);

            if (switchPending.load()) {
                outBackend.Stop();
                outBackend.Close();

                OutputStreamSpec nextSpec{};
                uint64_t nextSeq = 0;
                uint32_t nextPreRollMs = 0;
                std::string nextDsdLabel;
                {
                    std::lock_guard<std::mutex> slk(switchMutex);
                    activeIsDop = pendingSwitchReq.isDop;
                    activeRate = pendingSwitchReq.sampleRate;
                    activeChannels = pendingSwitchReq.channels;
                    activeInFmt = pendingSwitchReq.inFmt;
                    activeSrcBits = pendingSwitchReq.srcBits;
                    activeExclusivePref = pendingSwitchReq.exclusive;
                    activePushMode = pendingSwitchReq.pushMode;
                    activeBufferMs = pendingSwitchReq.bufferMs;
                    nextSeq = pendingSwitchReq.seq;
                    nextPreRollMs = pendingSwitchReq.preRollMs;
                    linearGain.store(pendingSwitchReq.linearGain);
                    nextDsdLabel = (activeIsDop && pendingSwitchReq.preloadedDop) ? pendingSwitchReq.preloadedDop->DsdLabel() : "";
                }

                const size_t nextRingCap = (activeRate > 384000u) ? 262144u : RING_FRAMES;
                ringI32.Reconfigure(activeInFmt == InputWireFormat::S32LE ? nextRingCap : 64u, activeChannels);
                ringF64.Reconfigure(activeInFmt != InputWireFormat::S32LE ? nextRingCap : 64u, activeChannels);
                {
                    std::lock_guard<std::mutex> blk(boundaryMutex);
                    trackBoundaries.clear();
                }

                nextSpec.sampleRate = activeRate;
                nextSpec.channels = activeChannels;
                nextSpec.exclusive = activeExclusivePref;
                nextSpec.isDop = activeIsDop;
                nextSpec.usePushMode = activePushMode;
                nextSpec.useAsio = activeUseAsio;
                nextSpec.asioDriver = opts.asioDriver;
                nextSpec.bufferMs = activeBufferMs;
                nextSpec.preRollMs = nextPreRollMs;
                nextSpec.deviceId = opts.deviceId;
                nextSpec.dsdLabel = nextDsdLabel;

                openRes = outBackend.Open(nextSpec);
                if (!openRes.ok) {
                    if (openRes.dopUnsupported) {
                        EmitJsonLine("{\"event\":\"dop_unsupported\",\"reason\":\"" + EscapeJson(openRes.dopRejectReason) + "\"}");
                    } else {
                        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + openRes.errorHresult + "\",\"message\":\"" + EscapeJson(openRes.errorMessage) + "\"}");
                    }
                    switchPending.store(false);
                    if (hSwitchDoneEvent) SetEvent(hSwitchDoneEvent);
                    stopRequested.store(true);
                    break;
                }

                activeExclusive = openRes.activeExclusive;
                wireFmt = openRes.wireFmt;
                chosenWfx = openRes.chosenWfx;
                bufferFrameCount = openRes.bufferFrameCount;
                deviceName = openRes.deviceName;
                renderRateAtomic.store(activeRate);

                DspConfigSnapshot curDsp;
                {
                    std::lock_guard<std::mutex> lk(dspConfigMutex);
                    curDsp = stagedDspConfig;
                    initialDsp = curDsp;
                }
                dspRack.ResetStates();
                dspRack.ApplyConfig(chosenWfx.Format.nSamplesPerSec, curDsp);
                truePeakLimiter.Reset();
                truePeakLimiter.Configure(chosenWfx.Format.nSamplesPerSec, -0.3);
                tpdfDither.Reset();
                std::memset(fftRing, 0, sizeof(fftRing));
                fftWritePos = 0;
                frameStats = TelemetryFrameStats{};
                audioMeters.ResetForTrack();
                {
                    std::lock_guard<std::mutex> clk(convolverLoadMutex);
                    if (!activeConvolverPath.empty() && !activeIsDop && !activeIsRawDsd) {
                        std::string rErr;
                        const double curWet = convolverHost.GetWetMix();
                        convolverHost.LoadFromFile(activeConvolverPath, chosenWfx.Format.nSamplesPerSec, curWet, Utf8ToWide(activeConvolverPath), rErr, nullptr);
                    }
                }
                totalFramesRendered = 0;
                currentTrackStartFrame = 0;
                framesPlayed.store(0);

                outBackend.PreFillSilence(bufferFrameCount, chosenWfx.Format.nBlockAlign);
                if (!outBackend.Start(startHresult)) {
                    EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + startHresult + "\",\"message\":\"IAudioClient::Start failed after format switch\"}");
                    switchPending.store(false);
                    if (hSwitchDoneEvent) SetEvent(hSwitchDoneEvent);
                    stopRequested.store(true);
                    break;
                }

                EmitSilencePreRoll(outBackend, nextPreRollMs, activeRate, activeChannels, chosenWfx.Format.nBlockAlign, activeIsDop, wireFmt, frameScratchI32);

                const bool bitExactNow = computeSignalState(curDsp, linearGain.load(), activeInFmt, activeSrcBits, activeIsDop, activeIsRawDsd, wireFmt);
                std::string advMsg = std::string("{\"event\":\"track_advanced\",\"seq\":") +
                    std::to_string(nextSeq) +
                    ",\"reinitialized\":true" +
                    ",\"mode\":\"" + (activeIsDop ? "dop_exclusive" : (activeExclusive ? "exclusive" : "shared")) + "\"" +
                    ",\"sampleRate\":" + std::to_string(chosenWfx.Format.nSamplesPerSec) +
                    ",\"bitsPerSample\":" + std::to_string(activeIsDop ? 24 : chosenWfx.Format.wBitsPerSample) +
                    ",\"validBits\":" + std::to_string(chosenWfx.Samples.wValidBitsPerSample) +
                    ",\"channels\":" + std::to_string(chosenWfx.Format.nChannels) +
                    ",\"bufferFrames\":" + std::to_string(bufferFrameCount) +
                    ",\"bitExact\":" + (bitExactNow ? "true" : "false") +
                    ",\"signalMode\":\"" + (activeIsDop ? "dop_exclusive" : (bitExactNow ? "bit_exact" : "purepath_64")) + "\"";
                if (activeIsDop && !nextDsdLabel.empty()) {
                    advMsg += ",\"dsdRate\":\"" + EscapeJson(nextDsdLabel) + "\"";
                }
                advMsg += "}";
                EmitJsonLine(advMsg);
                emitReadyEvent(nextDsdLabel, xrunCount.load());

                switchPending.store(false);
                if (hSwitchDoneEvent) SetEvent(hSwitchDoneEvent);

                for (int w = 0; w < 250 && ringAvailRead() < bufferFrameCount && !stdinEof.load() && !stopRequested.load(); w += 10) {
                    Sleep(10);
                }
                continue;
            }

            if (stdinEof.load()) break;
            if (totalFramesRendered > 0) {
                xrunCount.fetch_add(1);
            }
            continue;
        }

        if (gotFrames < framesToWrite) {
            if (activeIsRawDsd) {
                vanta_asio::AsioDriverHost::FillRawDsdSilence(
                    frameScratchRawDsd.data() + gotFrames * activeChannels,
                    (framesToWrite - gotFrames) * activeChannels
                );
            } else if (activeIsDop) {
                for (size_t f = gotFrames; f < framesToWrite; ++f) {
                    const int32_t muteWord = static_cast<int32_t>(PackDopWord24(f, 0x69u, 0x69u));
                    for (uint16_t ch = 0; ch < activeChannels; ++ch) {
                        frameScratchI32[f * activeChannels + ch] = muteWord;
                    }
                }
            } else if (activeInFmt == InputWireFormat::S32LE) {
                std::memset(
                    frameScratchI32.data() + gotFrames * activeChannels,
                    0,
                    (framesToWrite - gotFrames) * activeChannels * sizeof(int32_t)
                );
            } else {
                std::fill(
                    frameScratchF64.begin() + gotFrames * activeChannels,
                    frameScratchF64.begin() + framesToWrite * activeChannels,
                    0.0
                );
            }
        }

        if (activeIsRawDsd) {
            std::memcpy(pData, frameScratchRawDsd.data(), static_cast<size_t>(framesToWrite) * activeChannels);
            // Soft pulse-density envelope purely for visualizer telemetry (output bytes untouched)
            for (uint32_t f = 0; f < framesToWrite; ++f) {
                double mono = 0.0;
                for (uint16_t ch = 0; ch < activeChannels; ++ch) {
                    const uint8_t b = frameScratchRawDsd[static_cast<size_t>(f) * activeChannels + ch];
                    int ones = 0;
                    for (int bit = 0; bit < 8; ++bit) ones += (b >> bit) & 1;
                    const double sampleVal = (static_cast<double>(ones) - 4.0) / 4.0;
                    mono += sampleVal;
                    AccumulateTelemetrySample(sampleVal, ch, activeChannels, frameStats);
                    audioMeters.PushOutputSample(sampleVal, ch, 1u, 1u);
                }
                audioMeters.AdvanceFrame(activeChannels, activeRate);
                fftRing[fftWritePos] = static_cast<float>(mono / static_cast<double>(activeChannels > 0 ? activeChannels : 1));
                fftWritePos = (fftWritePos + 1) % FFT_N;
            }
            frameStats.frameCount += framesToWrite;
        } else if (activeIsDop) {
            WriteDopFrames(
                pData,
                frameScratchI32.data(),
                framesToWrite,
                activeChannels,
                wireFmt,
                fftRing,
                fftWritePos,
                frameStats
            );
        } else {
            vanta_convolver::ConvolverSlot64* convSlot = convolverHost.AcquireActiveForRender();
            if (activeInFmt == InputWireFormat::S32LE) {
                ConvertAndWriteFrames(
                    pData,
                    frameScratchI32.data(),
                    framesToWrite,
                    activeChannels,
                    wireFmt,
                    linearGain.load(),
                    dspRack,
                    truePeakLimiter,
                    tpdfDither,
                    fftRing,
                    fftWritePos,
                    frameStats,
                    activeSrcBits,
                    convSlot,
                    &audioMeters,
                    activeRate
                );
            } else {
                ConvertAndWriteFloatFrames(
                    pData,
                    frameScratchF64.data(),
                    framesToWrite,
                    activeChannels,
                    wireFmt,
                    linearGain.load(),
                    dspRack,
                    truePeakLimiter,
                    tpdfDither,
                    fftRing,
                    fftWritePos,
                    frameStats,
                    activeSrcBits,
                    convSlot,
                    &audioMeters,
                    activeRate
                );
            }
            convolverHost.ReleaseRenderSlot();
        }

        outBackend.ReleaseBuffer(framesToWrite, 0);
        totalFramesRendered += gotFrames;
        {
            std::lock_guard<std::mutex> blk(boundaryMutex);
            while (!trackBoundaries.empty() && totalFramesRendered >= trackBoundaries.front().totalRingFramePos) {
                const TrackBoundary tb = trackBoundaries.front();
                trackBoundaries.erase(trackBoundaries.begin());
                currentTrackStartFrame = tb.totalRingFramePos;
                activeSrcBits = tb.srcBits;
                linearGain.store(tb.linearGain);
                truePeakLimiter.Reset();
                tpdfDither.Reset();
                audioMeters.ResetForTrack();
                const bool bitExactNow = computeSignalState(dspRack.cfg, linearGain.load(), activeInFmt, activeSrcBits, activeIsDop, activeIsRawDsd, wireFmt);
                const std::string advMsg = std::string("{\"event\":\"track_advanced\",\"seq\":") +
                    std::to_string(tb.seq) +
                    ",\"sampleRate\":" + std::to_string(chosenWfx.Format.nSamplesPerSec) +
                    ",\"bitExact\":" + (bitExactNow ? "true" : "false") +
                    ",\"signalMode\":\"" + (bitExactNow ? "bit_exact" : "purepath_64") + "\"}";
                EmitJsonLine(advMsg);
            }
        }
        framesPlayed.store(totalFramesRendered >= currentTrackStartFrame ? (totalFramesRendered - currentTrackStartFrame) : 0);

        const ULONGLONG nowTick = GetTickCount64();
        if (nowTick - lastTelemetryTick >= 33) {
            lastTelemetryTick = nowTick;
            float bars[24] = {};
            float wave32[32] = {};
            ComputeLogFft24(fftRing, fftWritePos, activeRate, bars, wave32);

            const double denom = frameStats.frameCount > 0 ? static_cast<double>(frameStats.frameCount) : 1.0;
            const float lRms = static_cast<float>(std::sqrt(frameStats.lSumSq / denom));
            const float rRms = static_cast<float>(std::sqrt(frameStats.rSumSq / denom));
            const float peak = std::max(frameStats.lPeak, frameStats.rPeak);
            const float lPeak = frameStats.lPeak;
            const float rPeak = frameStats.rPeak;
            const double avgRms = 0.5 * (static_cast<double>(lRms) + static_cast<double>(rRms));
            const double crestDb = (peak > 1e-5f && avgRms > 1e-6)
                ? ClampDouble(20.0 * std::log10(static_cast<double>(peak) / avgRms), 0.0, 40.0)
                : 0.0;
            const double truePeakDbtp = (activeIsRawDsd || activeIsDop)
                ? (peak > 1e-6f ? 20.0 * std::log10(static_cast<double>(peak)) : -120.0)
                : audioMeters.ReadWindowTruePeakDbtpAndReset();
            const double drDb = (activeIsRawDsd || activeIsDop) ? crestDb : audioMeters.ComputeSessionDrDb(crestDb);
            const uint32_t activeBits = (activeIsRawDsd || activeIsDop) ? 1u : audioMeters.CurrentWireActiveBits();
            const uint32_t srcActiveBits = (activeIsRawDsd || activeIsDop) ? 1u : audioMeters.CurrentSrcActiveBits();
            frameStats = TelemetryFrameStats{};

            const uint64_t posMs = (framesPlayed.load() * 1000ULL) / activeRate;
            char hdr[512];
            std::snprintf(
                hdr,
                sizeof(hdr),
                "{\"event\":\"spectrum\",\"positionMs\":%llu,\"xrunCount\":%llu,\"peak\":%.4f,\"lPeak\":%.4f,\"rPeak\":%.4f,\"lRms\":%.4f,\"rRms\":%.4f,\"truePeakDbtp\":%.2f,\"crestDb\":%.2f,\"drDb\":%.2f,\"activeBits\":%u,\"srcActiveBits\":%u,\"peqActive\":%s,\"convolverActive\":%s,\"bars\":[",
                static_cast<unsigned long long>(posMs),
                static_cast<unsigned long long>(xrunCount.load()),
                peak,
                lPeak,
                rPeak,
                lRms,
                rRms,
                truePeakDbtp,
                crestDb,
                drDb,
                static_cast<unsigned int>(activeBits),
                static_cast<unsigned int>(srcActiveBits),
                dspRack.cfg.peq.HasActive() ? "true" : "false",
                convolverHost.IsActive() ? "true" : "false"
            );
            std::string spec(hdr);
            for (int b = 0; b < 24; ++b) {
                if (b > 0) spec += ",";
                char nb[16];
                std::snprintf(nb, sizeof(nb), "%.3f", bars[b]);
                spec += nb;
            }
            spec += "],\"wave\":[";
            for (int w = 0; w < 32; ++w) {
                if (w > 0) spec += ",";
                char wb[16];
                std::snprintf(wb, sizeof(wb), "%.3f", wave32[w]);
                spec += wb;
            }
            spec += "]}";
            EmitJsonLine(spec);
        }
    }

    const uint64_t finalPosMs = (framesPlayed.load() * 1000ULL) / (activeRate > 0 ? activeRate : 48000u);
    const uint64_t finalXruns = xrunCount.load();
    const bool wasStoppedByCmd = stopRequested.load();

    outBackend.Stop();
    if (hMmcss) AvRevertMmThreadCharacteristics(hMmcss);

    stopRequested.store(true);
    if (hSwitchDoneEvent) SetEvent(hSwitchDoneEvent);
    cancelQueuedStream();
    {
        std::lock_guard<std::mutex> slk(switchMutex);
        closeQueuedReqResources(pendingSwitchReq);
    }
    if (readerThread.joinable()) readerThread.join();
    if (ctrlThread.joinable()) ctrlThread.join();
    if (hSwitchDoneEvent) CloseHandle(hSwitchDoneEvent);

    outBackend.Close();

    if (wasStoppedByCmd) {
        EmitJsonLine("{\"event\":\"stopped\",\"positionMs\":" + std::to_string(finalPosMs) + ",\"xrunCount\":" + std::to_string(finalXruns) + "}");
    }
    EmitJsonLine("{\"event\":\"ended\",\"positionMs\":" + std::to_string(finalPosMs) + ",\"xrunCount\":" + std::to_string(finalXruns) + "}");
    return 0;
}
