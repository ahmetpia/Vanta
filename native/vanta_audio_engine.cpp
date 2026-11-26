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
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

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

class PcmRingBuffer {
public:
    explicit PcmRingBuffer(size_t capacityFrames, uint32_t channels)
        : m_capacity(capacityFrames),
          m_channels(channels),
          m_data(capacityFrames * channels, 0) {}

    size_t AvailableToRead() const {
        const size_t w = m_writePos.load(std::memory_order_acquire);
        const size_t r = m_readPos.load(std::memory_order_acquire);
        return w - r;
    }

    size_t AvailableToWrite() const {
        return m_capacity - AvailableToRead();
    }

    size_t Write(const int32_t* src, size_t frames) {
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

    size_t Read(int32_t* dst, size_t frames) {
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
    std::vector<int32_t> m_data;
    std::atomic<size_t> m_writePos{0};
    std::atomic<size_t> m_readPos{0};
};

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

void ConvertAndWriteFrames(
    BYTE* pOut,
    const int32_t* pIn,
    uint32_t frames,
    uint32_t channels,
    WireSampleFormat wireFmt,
    float gain,
    float* fftRing,
    size_t& fftWritePos,
    TelemetryFrameStats& stats) {
    const size_t totalSamples = static_cast<size_t>(frames) * channels;
    const double g = static_cast<double>(gain);

    for (uint32_t f = 0; f < frames; ++f) {
        double mono = 0.0;
        for (uint32_t ch = 0; ch < channels; ++ch) {
            const size_t i = static_cast<size_t>(f) * channels + ch;
            double normalized = (static_cast<double>(pIn[i]) / 2147483648.0) * g;
            if (normalized > 1.0) normalized = 1.0;
            if (normalized < -1.0) normalized = -1.0;

            const float fn = static_cast<float>(normalized);
            const float absVal = std::fabs(fn);
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

            switch (wireFmt) {
                case WireSampleFormat::Float32: {
                    float* fOut = reinterpret_cast<float*>(pOut);
                    fOut[i] = fn;
                    break;
                }
                case WireSampleFormat::Pcm32: {
                    int32_t* iOut = reinterpret_cast<int32_t*>(pOut);
                    iOut[i] = static_cast<int32_t>(normalized * 2147483647.0);
                    break;
                }
                case WireSampleFormat::Pcm24In32: {
                    int32_t* iOut = reinterpret_cast<int32_t*>(pOut);
                    int32_t s24 = static_cast<int32_t>(normalized * 8388607.0);
                    iOut[i] = (s24 << 8);
                    break;
                }
                case WireSampleFormat::Pcm24Packed: {
                    int32_t s24 = static_cast<int32_t>(normalized * 8388607.0);
                    BYTE* b = pOut + i * 3;
                    b[0] = static_cast<BYTE>(s24 & 0xFF);
                    b[1] = static_cast<BYTE>((s24 >> 8) & 0xFF);
                    b[2] = static_cast<BYTE>((s24 >> 16) & 0xFF);
                    break;
                }
                case WireSampleFormat::Pcm16: {
                    int16_t* sOut = reinterpret_cast<int16_t*>(pOut);
                    sOut[i] = static_cast<int16_t>(normalized * 32767.0);
                    break;
                }
            }
        }
        fftRing[fftWritePos] = static_cast<float>(mono / static_cast<double>(channels > 0 ? channels : 1));
        fftWritePos = (fftWritePos + 1) % FFT_N;
    }
    stats.frameCount += frames;
    (void)totalSamples;
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
    if (dsdRate == 2822400u) return "DSD64";
    if (dsdRate == 5644800u) return "DSD128";
    if (dsdRate == 11289600u) return "DSD256";
    if (dsdRate == 22579200u) return "DSD512";
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

    bool Open(const std::string& path, double seekSec, std::string& outErr) {
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

        if (m_carrierRate > 768000u) {
            outErr = "DoP carrier rate exceeds 768 kHz (" + m_dsdLabel + " requires native ASIO or DXD PCM fallback)";
            Close();
            return false;
        }

        if (seekSec > 0.0) {
            const uint64_t targetFrames = static_cast<uint64_t>(
                (seekSec * static_cast<double>(m_dsdSampleRate)) / 16.0
            );
            SeekToCarrierFrame(targetFrames);
        }
        return true;
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

struct EngineOptions {
    bool listDevices = false;
    bool volumeMonitor = false;
    bool exclusive = true;
    uint32_t sampleRate = 48000;
    uint16_t channels = DEFAULT_CHANNELS;
    float initialGain = 1.0f;
    double seekSec = 0.0;
    std::string deviceId;
    std::string ctrlPipeName;
    std::string dopFile;
    std::string testDopFile;
};

EngineOptions ParseArgs(int argc, char** argv) {
    EngineOptions opts;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--list-devices") {
            opts.listDevices = true;
        } else if (arg == "--volume-monitor") {
            opts.volumeMonitor = true;
        } else if (arg == "--shared") {
            opts.exclusive = false;
        } else if (arg == "--exclusive") {
            opts.exclusive = true;
        } else if (arg == "--rate" && i + 1 < argc) {
            opts.sampleRate = static_cast<uint32_t>(std::strtoul(argv[++i], nullptr, 10));
        } else if (arg == "--channels" && i + 1 < argc) {
            opts.channels = static_cast<uint16_t>(std::strtoul(argv[++i], nullptr, 10));
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
        }
    }
    if (opts.sampleRate < 8000 || opts.sampleRate > 768000) opts.sampleRate = 48000;
    if (opts.channels < 1 || opts.channels > 8) opts.channels = 2;
    if (opts.seekSec < 0.0) opts.seekSec = 0.0;
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

} // namespace

int main(int argc, char** argv) {
    const EngineOptions opts = ParseArgs(argc, argv);

    if (opts.listDevices) {
        return ListAudioDevices();
    }
    if (opts.volumeMonitor) {
        return RunVolumeMonitor(opts.deviceId);
    }
    if (!opts.testDopFile.empty()) {
        return RunDopSelfTest(opts.testDopFile);
    }

    const bool isDop = !opts.dopFile.empty();
    DopStreamReader dopReader;
    uint32_t activeRate = opts.sampleRate;
    uint16_t activeChannels = opts.channels;

    if (isDop) {
        if (!opts.exclusive) {
            EmitJsonLine("{\"event\":\"dop_unsupported\",\"reason\":\"DoP v1.1 requires WASAPI Exclusive Mode\"}");
            return 10;
        }
        std::string dopErr;
        if (!dopReader.Open(opts.dopFile, opts.seekSec, dopErr)) {
            EmitJsonLine("{\"event\":\"dop_unsupported\",\"reason\":\"" + EscapeJson(dopErr) + "\"}");
            return 10;
        }
        activeRate = dopReader.CarrierRate();
        activeChannels = dopReader.Channels();
    } else {
        _setmode(_fileno(stdin), _O_BINARY);
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"CoInitializeEx failed\"}");
        return 1;
    }

    IMMDeviceEnumerator* pEnum = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&pEnum));
    if (FAILED(hr) || !pEnum) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"MMDeviceEnumerator creation failed\"}");
        CoUninitialize();
        return 2;
    }

    IMMDevice* pDevice = nullptr;
    if (!opts.deviceId.empty()) {
        std::wstring wid = Utf8ToWide(opts.deviceId);
        hr = pEnum->GetDevice(wid.c_str(), &pDevice);
        if (FAILED(hr) || !pDevice) {
            hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        }
    } else {
        hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    }

    if (FAILED(hr) || !pDevice) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"No active audio output device found\"}");
        pEnum->Release();
        CoUninitialize();
        return 3;
    }

    const std::string deviceName = ReadDeviceFriendlyName(pDevice);

    IAudioClient* pAudioClient = nullptr;
    hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pAudioClient));
    if (FAILED(hr) || !pAudioClient) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"IAudioClient activation failed\"}");
        pDevice->Release();
        pEnum->Release();
        CoUninitialize();
        return 4;
    }

    bool activeExclusive = false;
    WireSampleFormat wireFmt = WireSampleFormat::Pcm32;
    WAVEFORMATEXTENSIBLE chosenWfx{};
    UINT32 bufferFrameCount = 0;

    if (opts.exclusive) {
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
        const CandidateFmt* candPtr = isDop ? dopFirstCandidates : pcmCandidates;
        const size_t candCount = isDop ? (sizeof(dopFirstCandidates) / sizeof(dopFirstCandidates[0]))
                                       : (sizeof(pcmCandidates) / sizeof(pcmCandidates[0]));

        for (size_t ci = 0; ci < candCount; ++ci) {
            const auto& c = candPtr[ci];
            if (isDop && !c.allowedForDop) continue;
            WAVEFORMATEXTENSIBLE testWfx = BuildFormat(activeRate, activeChannels, c.containerBits, c.validBits, c.isFloat);
            hr = pAudioClient->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, reinterpret_cast<WAVEFORMATEX*>(&testWfx), nullptr);
            if (hr == S_OK) {
                REFERENCE_TIME defPeriod = 0;
                REFERENCE_TIME minPeriod = 0;
                pAudioClient->GetDevicePeriod(&defPeriod, &minPeriod);
                REFERENCE_TIME hnsPeriod = (defPeriod > 0) ? defPeriod : 100000;

                hr = pAudioClient->Initialize(
                    AUDCLNT_SHAREMODE_EXCLUSIVE,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    hnsPeriod,
                    hnsPeriod,
                    reinterpret_cast<WAVEFORMATEX*>(&testWfx),
                    nullptr
                );

                // Per Microsoft Docs: handle AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED by querying GetBufferSize and re-initializing
                if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
                    if (SUCCEEDED(pAudioClient->GetBufferSize(&bufferFrameCount)) && bufferFrameCount > 0) {
                        REFERENCE_TIME alignedPeriod = static_cast<REFERENCE_TIME>(
                            (10000.0 * 1000.0 / static_cast<double>(activeRate) * static_cast<double>(bufferFrameCount)) + 0.5
                        );
                        pAudioClient->Release();
                        pAudioClient = nullptr;
                        hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pAudioClient));
                        if (SUCCEEDED(hr) && pAudioClient) {
                            hr = pAudioClient->Initialize(
                                AUDCLNT_SHAREMODE_EXCLUSIVE,
                                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                alignedPeriod,
                                alignedPeriod,
                                reinterpret_cast<WAVEFORMATEX*>(&testWfx),
                                nullptr
                            );
                        }
                    }
                }

                if (SUCCEEDED(hr)) {
                    activeExclusive = true;
                    wireFmt = c.wireFmt;
                    chosenWfx = testWfx;
                    break;
                } else if (pAudioClient) {
                    pAudioClient->Release();
                    pAudioClient = nullptr;
                    pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pAudioClient));
                }
            }
        }
    }

    // Strict DoP gate: never downgrade DoP bitstreams into WASAPI Shared mixer or float resampling
    if (isDop && !activeExclusive) {
        EmitJsonLine(
            "{\"event\":\"dop_unsupported\",\"reason\":\"DAC rejected bit-exact integer DoP carrier (" +
            dopReader.DsdLabel() + " @ " + std::to_string(activeRate) + "Hz) in WASAPI Exclusive mode\"}"
        );
        if (pAudioClient) pAudioClient->Release();
        pDevice->Release();
        pEnum->Release();
        CoUninitialize();
        return 10;
    }

    // Fallback cleanly to WASAPI Shared Mode with AUTOCONVERTPCM if Exclusive was not requested or hardware rejected exclusive access
    if (!activeExclusive) {
        if (!pAudioClient) {
            hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&pAudioClient));
        }
        chosenWfx = BuildFormat(activeRate, activeChannels, 32, 32, true);
        wireFmt = WireSampleFormat::Float32;

        REFERENCE_TIME defPeriod = 0;
        REFERENCE_TIME minPeriod = 0;
        pAudioClient->GetDevicePeriod(&defPeriod, &minPeriod);
        REFERENCE_TIME sharedBuf = (defPeriod > 0) ? defPeriod * 4 : 400000;

        hr = pAudioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            sharedBuf,
            0,
            reinterpret_cast<WAVEFORMATEX*>(&chosenWfx),
            nullptr
        );

        if (FAILED(hr)) {
            EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"IAudioClient::Initialize failed in both Exclusive and Shared mode\"}");
            if (pAudioClient) pAudioClient->Release();
            pDevice->Release();
            pEnum->Release();
            CoUninitialize();
            return 5;
        }
    }

    hr = pAudioClient->GetBufferSize(&bufferFrameCount);
    if (FAILED(hr) || bufferFrameCount == 0) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"GetBufferSize failed\"}");
        pAudioClient->Release();
        pDevice->Release();
        pEnum->Release();
        CoUninitialize();
        return 6;
    }

    HANDLE hAudioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (hAudioEvent) {
        hr = pAudioClient->SetEventHandle(hAudioEvent);
    }
    if (!hAudioEvent || FAILED(hr)) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"SetEventHandle failed\"}");
        if (hAudioEvent) CloseHandle(hAudioEvent);
        pAudioClient->Release();
        pDevice->Release();
        pEnum->Release();
        CoUninitialize();
        return 7;
    }

    IAudioRenderClient* pRenderClient = nullptr;
    hr = pAudioClient->GetService(IID_PPV_ARGS(&pRenderClient));
    if (FAILED(hr) || !pRenderClient) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"GetService(IAudioRenderClient) failed\"}");
        CloseHandle(hAudioEvent);
        pAudioClient->Release();
        pDevice->Release();
        pEnum->Release();
        CoUninitialize();
        return 8;
    }

    std::string readyJson = "{\"event\":\"ready\",\"mode\":\"";
    readyJson += isDop ? "dop_exclusive" : (activeExclusive ? "exclusive" : "shared");
    if (isDop) {
        readyJson += "\",\"dsdRate\":\"" + dopReader.DsdLabel();
    }
    readyJson += "\",\"sampleRate\":" + std::to_string(chosenWfx.Format.nSamplesPerSec) +
        ",\"bitsPerSample\":" + std::to_string(isDop ? 24 : chosenWfx.Format.wBitsPerSample) +
        ",\"validBits\":" + std::to_string(chosenWfx.Samples.wValidBitsPerSample) +
        ",\"channels\":" + std::to_string(chosenWfx.Format.nChannels) +
        ",\"bufferFrames\":" + std::to_string(bufferFrameCount) +
        ",\"deviceName\":\"" + EscapeJson(deviceName) + "\"}";
    EmitJsonLine(readyJson);

    std::atomic<bool> stopRequested{false};
    std::atomic<bool> paused{false};
    std::atomic<bool> stdinEof{false};
    std::atomic<float> linearGain{opts.initialGain};
    std::atomic<uint64_t> framesPlayed{0};

    const size_t ringFrames = (activeRate > 384000u) ? 262144u : RING_FRAMES;
    PcmRingBuffer ring(ringFrames, activeChannels);

    // Control named-pipe thread (zero firewall prompts, <0.1ms Pause/Resume/Gain/Stop)
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
            char buf[256];
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
                    } else if (cmd == "RESUME") {
                        paused.store(false);
                    } else if (cmd == "STOP") {
                        stopRequested.store(true);
                    } else if (cmd.rfind("GAIN ", 0) == 0) {
                        float g = std::strtof(cmd.c_str() + 5, nullptr);
                        if (g >= 0.0f && g <= 2.5f) linearGain.store(g);
                    }
                }
            }
            CloseHandle(hPipe);
        });
    }

    // Stream producer thread (direct DSF/DFF DoP packetizer or stdin PCM reader)
    std::thread readerThread([&]() {
        const size_t chunkFrames = 4096;
        std::vector<int32_t> temp(chunkFrames * activeChannels);
        const size_t frameBytes = sizeof(int32_t) * activeChannels;

        while (!stopRequested.load()) {
            const size_t space = ring.AvailableToWrite();
            if (space < chunkFrames) {
                Sleep(4);
                continue;
            }
            const size_t framesRead = isDop
                ? dopReader.ReadCarrierFrames(temp.data(), chunkFrames)
                : std::fread(temp.data(), frameBytes, chunkFrames, stdin);
            if (framesRead == 0) {
                stdinEof.store(true);
                break;
            }
            size_t written = 0;
            while (written < framesRead && !stopRequested.load()) {
                size_t n = ring.Write(temp.data() + written * activeChannels, framesRead - written);
                written += n;
                if (written < framesRead) Sleep(2);
            }
        }
    });

    // Wait briefly to prefill ring buffer so event-driven render starts glitch-free
    for (int waitMs = 0; waitMs < 400 && ring.AvailableToRead() < bufferFrameCount * 2 && !stdinEof.load(); waitMs += 10) {
        Sleep(10);
    }

    // Elevate render thread priority using MMCSS ("Pro Audio") per Microsoft WASAPI guidelines
    DWORD taskIndex = 0;
    HANDLE hMmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    // Pre-fill initial buffer with silence before calling Start()
    BYTE* pInitData = nullptr;
    if (SUCCEEDED(pRenderClient->GetBuffer(bufferFrameCount, &pInitData)) && pInitData) {
        std::memset(pInitData, 0, static_cast<size_t>(bufferFrameCount) * chosenWfx.Format.nBlockAlign);
        pRenderClient->ReleaseBuffer(bufferFrameCount, AUDCLNT_BUFFERFLAGS_SILENT);
    }

    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        EmitJsonLine("{\"event\":\"error\",\"hresult\":\"" + FormatHResult(hr) + "\",\"message\":\"IAudioClient::Start failed\"}");
        stopRequested.store(true);
    }

    std::vector<int32_t> frameScratch(static_cast<size_t>(bufferFrameCount) * activeChannels);
    float fftRing[FFT_N] = {};
    size_t fftWritePos = 0;
    TelemetryFrameStats frameStats{};
    ULONGLONG lastTelemetryTick = GetTickCount64();

    while (!stopRequested.load()) {
        const DWORD waitRes = WaitForSingleObject(hAudioEvent, 500);
        if (waitRes != WAIT_OBJECT_0) {
            if (stdinEof.load() && ring.AvailableToRead() == 0) break;
            continue;
        }

        UINT32 framesToWrite = bufferFrameCount;
        if (!activeExclusive) {
            UINT32 padding = 0;
            if (SUCCEEDED(pAudioClient->GetCurrentPadding(&padding))) {
                if (padding >= bufferFrameCount) continue;
                framesToWrite = bufferFrameCount - padding;
            }
        }

        if (framesToWrite == 0) continue;

        BYTE* pData = nullptr;
        hr = pRenderClient->GetBuffer(framesToWrite, &pData);
        if (FAILED(hr) || !pData) continue;

        if (paused.load()) {
            if (isDop) {
                if (frameScratch.size() < static_cast<size_t>(framesToWrite) * activeChannels) {
                    frameScratch.resize(static_cast<size_t>(framesToWrite) * activeChannels);
                }
                for (uint32_t f = 0; f < framesToWrite; ++f) {
                    const int32_t muteWord = static_cast<int32_t>(PackDopWord24(f, 0x69u, 0x69u));
                    for (uint16_t ch = 0; ch < activeChannels; ++ch) {
                        frameScratch[static_cast<size_t>(f) * activeChannels + ch] = muteWord;
                    }
                }
                size_t dummyPos = fftWritePos;
                TelemetryFrameStats dummyStats{};
                WriteDopFrames(pData, frameScratch.data(), framesToWrite, activeChannels, wireFmt, fftRing, dummyPos, dummyStats);
                pRenderClient->ReleaseBuffer(framesToWrite, 0);
            } else {
                std::memset(pData, 0, static_cast<size_t>(framesToWrite) * chosenWfx.Format.nBlockAlign);
                pRenderClient->ReleaseBuffer(framesToWrite, AUDCLNT_BUFFERFLAGS_SILENT);
            }
            continue;
        }

        if (frameScratch.size() < static_cast<size_t>(framesToWrite) * activeChannels) {
            frameScratch.resize(static_cast<size_t>(framesToWrite) * activeChannels);
        }

        const size_t gotFrames = ring.Read(frameScratch.data(), framesToWrite);
        if (gotFrames == 0) {
            std::memset(pData, 0, static_cast<size_t>(framesToWrite) * chosenWfx.Format.nBlockAlign);
            pRenderClient->ReleaseBuffer(framesToWrite, AUDCLNT_BUFFERFLAGS_SILENT);
            if (stdinEof.load()) break;
            continue;
        }

        if (gotFrames < framesToWrite) {
            if (isDop) {
                for (size_t f = gotFrames; f < framesToWrite; ++f) {
                    const int32_t muteWord = static_cast<int32_t>(PackDopWord24(f, 0x69u, 0x69u));
                    for (uint16_t ch = 0; ch < activeChannels; ++ch) {
                        frameScratch[f * activeChannels + ch] = muteWord;
                    }
                }
            } else {
                std::memset(
                    frameScratch.data() + gotFrames * activeChannels,
                    0,
                    (framesToWrite - gotFrames) * activeChannels * sizeof(int32_t)
                );
            }
        }

        if (isDop) {
            WriteDopFrames(
                pData,
                frameScratch.data(),
                framesToWrite,
                activeChannels,
                wireFmt,
                fftRing,
                fftWritePos,
                frameStats
            );
        } else {
            ConvertAndWriteFrames(
                pData,
                frameScratch.data(),
                framesToWrite,
                activeChannels,
                wireFmt,
                linearGain.load(),
                fftRing,
                fftWritePos,
                frameStats
            );
        }

        pRenderClient->ReleaseBuffer(framesToWrite, 0);
        framesPlayed.fetch_add(gotFrames);

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
            frameStats = TelemetryFrameStats{};

            const uint64_t posMs = (framesPlayed.load() * 1000ULL) / activeRate;
            char hdr[256];
            std::snprintf(
                hdr,
                sizeof(hdr),
                "{\"event\":\"spectrum\",\"positionMs\":%llu,\"peak\":%.4f,\"lPeak\":%.4f,\"rPeak\":%.4f,\"lRms\":%.4f,\"rRms\":%.4f,\"bars\":[",
                static_cast<unsigned long long>(posMs),
                peak,
                lPeak,
                rPeak,
                lRms,
                rRms
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

    pAudioClient->Stop();
    if (hMmcss) AvRevertMmThreadCharacteristics(hMmcss);

    stopRequested.store(true);
    if (readerThread.joinable()) readerThread.join();
    if (ctrlThread.joinable()) ctrlThread.join();

    CloseHandle(hAudioEvent);
    pRenderClient->Release();
    pAudioClient->Release();
    pDevice->Release();
    pEnum->Release();
    CoUninitialize();

    EmitJsonLine("{\"event\":\"ended\"}");
    return 0;
}
