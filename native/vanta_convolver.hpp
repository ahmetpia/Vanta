#pragma once

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace vanta_convolver {

constexpr double kPi = 3.14159265358979323846;
constexpr size_t kPartSize = 512;
constexpr size_t kFftSize = 1024;
constexpr size_t kHalfBins = (kFftSize / 2) + 1; // 513

struct Complex64 {
    double re = 0.0;
    double im = 0.0;
};

inline void FftInPlace(std::vector<Complex64>& a, bool inverse) {
    const size_t n = a.size();
    if (n <= 1) return;

    for (size_t i = 1, j = 0; i < n; ++i) {
        size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            std::swap(a[i], a[j]);
        }
    }

    for (size_t len = 2; len <= n; len <<= 1) {
        const double ang = (inverse ? 2.0 : -2.0) * kPi / static_cast<double>(len);
        const double wlenRe = std::cos(ang);
        const double wlenIm = std::sin(ang);
        const size_t half = len >> 1;
        for (size_t i = 0; i < n; i += len) {
            double wRe = 1.0;
            double wIm = 0.0;
            for (size_t j = 0; j < half; ++j) {
                const size_t u = i + j;
                const size_t v = u + half;
                const double tRe = a[v].re * wRe - a[v].im * wIm;
                const double tIm = a[v].re * wIm + a[v].im * wRe;
                a[v].re = a[u].re - tRe;
                a[v].im = a[u].im - tIm;
                a[u].re += tRe;
                a[u].im += tIm;
                const double nextWRe = wRe * wlenRe - wIm * wlenIm;
                wIm = wRe * wlenIm + wIm * wlenRe;
                wRe = nextWRe;
            }
        }
    }

    if (inverse) {
        const double invN = 1.0 / static_cast<double>(n);
        for (size_t i = 0; i < n; ++i) {
            a[i].re *= invN;
            a[i].im *= invN;
        }
    }
}

struct WavIrData {
    uint32_t sampleRate = 0;
    uint16_t channels = 0;
    size_t frameCount = 0;
    std::vector<std::vector<double>> ch;
};

inline uint16_t ReadU16LE(const uint8_t* p) {
    return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8);
}

inline uint32_t ReadU32LE(const uint8_t* p) {
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8) |
           (static_cast<uint32_t>(p[2]) << 16) |
           (static_cast<uint32_t>(p[3]) << 24);
}

inline bool LoadWavIrFromFile(const std::wstring& wPath, WavIrData& out, std::string& outErr) {
    out = WavIrData{};
    if (wPath.empty()) {
        outErr = "Empty IR file path";
        return false;
    }
    FILE* fp = nullptr;
    if (_wfopen_s(&fp, wPath.c_str(), L"rb") != 0 || !fp) {
        outErr = "Unable to open IR WAV file";
        return false;
    }

    uint8_t riffHdr[12] = {};
    if (std::fread(riffHdr, 1, 12, fp) != 12 ||
        std::memcmp(riffHdr, "RIFF", 4) != 0 ||
        std::memcmp(riffHdr + 8, "WAVE", 4) != 0) {
        std::fclose(fp);
        outErr = "Not a valid RIFF/WAVE file";
        return false;
    }

    bool gotFmt = false;
    bool gotData = false;
    uint16_t formatTag = 0;
    uint16_t channels = 0;
    uint32_t sampleRate = 0;
    uint16_t bitsPerSample = 0;
    uint16_t blockAlign = 0;
    std::vector<uint8_t> dataBytes;

    while (!gotData) {
        uint8_t ckHdr[8] = {};
        if (std::fread(ckHdr, 1, 8, fp) != 8) break;
        const uint32_t ckSize = ReadU32LE(ckHdr + 4);
        if (ckSize > 134217728u) {
            std::fclose(fp);
            outErr = "WAV chunk exceeds 128 MB safety limit";
            return false;
        }

        if (std::memcmp(ckHdr, "fmt ", 4) == 0 && ckSize >= 16) {
            std::vector<uint8_t> fmtBuf(ckSize);
            if (std::fread(fmtBuf.data(), 1, ckSize, fp) != ckSize) {
                std::fclose(fp);
                outErr = "Truncated WAV fmt chunk";
                return false;
            }
            formatTag = ReadU16LE(fmtBuf.data());
            channels = ReadU16LE(fmtBuf.data() + 2);
            sampleRate = ReadU32LE(fmtBuf.data() + 4);
            blockAlign = ReadU16LE(fmtBuf.data() + 12);
            bitsPerSample = ReadU16LE(fmtBuf.data() + 14);

            if (formatTag == 0xFFFEu && ckSize >= 40) {
                const uint16_t subTag = ReadU16LE(fmtBuf.data() + 24);
                formatTag = subTag;
            }
            gotFmt = true;
            if (ckSize & 1u) {
                _fseeki64(fp, 1, SEEK_CUR);
            }
        } else if (std::memcmp(ckHdr, "data", 4) == 0) {
            dataBytes.resize(ckSize);
            if (ckSize > 0 && std::fread(dataBytes.data(), 1, ckSize, fp) != ckSize) {
                std::fclose(fp);
                outErr = "Truncated WAV audio payload";
                return false;
            }
            gotData = true;
        } else {
            const __int64 skip = static_cast<__int64>(ckSize) + static_cast<__int64>(ckSize & 1u);
            if (_fseeki64(fp, skip, SEEK_CUR) != 0) break;
        }
    }
    std::fclose(fp);

    if (!gotFmt || !gotData) {
        outErr = "Missing WAV fmt or data chunk";
        return false;
    }
    if (sampleRate < 8000u || sampleRate > 768000u) {
        outErr = "Unsupported IR sample rate";
        return false;
    }
    if (channels != 1u && channels != 2u && channels != 4u) {
        outErr = "IR must be 1ch (mono), 2ch (stereo), or 4ch (true-stereo)";
        return false;
    }
    if (formatTag != 1u && formatTag != 3u) {
        outErr = "IR WAV format must be PCM integer or IEEE float";
        return false;
    }
    const uint16_t bytesPerSample = static_cast<uint16_t>(bitsPerSample / 8u);
    if (bytesPerSample == 0u || blockAlign < static_cast<uint16_t>(bytesPerSample * channels)) {
        outErr = "Invalid IR WAV bit depth or block align";
        return false;
    }
    const size_t frames = dataBytes.size() / blockAlign;
    if (frames == 0 || frames > 16777216u) {
        outErr = "IR frame count out of range [1, 16M]";
        return false;
    }

    out.sampleRate = sampleRate;
    out.channels = channels;
    out.frameCount = frames;
    out.ch.assign(channels, std::vector<double>(frames, 0.0));

    for (size_t f = 0; f < frames; ++f) {
        const uint8_t* framePtr = dataBytes.data() + f * blockAlign;
        for (uint16_t c = 0; c < channels; ++c) {
            const uint8_t* sPtr = framePtr + c * bytesPerSample;
            double v = 0.0;
            if (formatTag == 3u) {
                if (bitsPerSample == 32u) {
                    float f32 = 0.0f;
                    std::memcpy(&f32, sPtr, sizeof(float));
                    v = static_cast<double>(f32);
                } else if (bitsPerSample == 64u) {
                    double f64 = 0.0;
                    std::memcpy(&f64, sPtr, sizeof(double));
                    v = f64;
                } else {
                    outErr = "Unsupported IEEE float IR bit depth";
                    return false;
                }
            } else {
                if (bitsPerSample == 16u) {
                    const int16_t s16 = static_cast<int16_t>(ReadU16LE(sPtr));
                    v = static_cast<double>(s16) / 32768.0;
                } else if (bitsPerSample == 24u) {
                    uint32_t u = static_cast<uint32_t>(sPtr[0]) |
                                 (static_cast<uint32_t>(sPtr[1]) << 8) |
                                 (static_cast<uint32_t>(sPtr[2]) << 16);
                    if (u & 0x800000u) u |= 0xFF000000u;
                    const int32_t s24 = static_cast<int32_t>(u);
                    v = static_cast<double>(s24) / 8388608.0;
                } else if (bitsPerSample == 32u) {
                    const int32_t s32 = static_cast<int32_t>(ReadU32LE(sPtr));
                    v = static_cast<double>(s32) / 2147483648.0;
                } else {
                    outErr = "Unsupported PCM IR bit depth";
                    return false;
                }
            }
            if (!std::isfinite(v)) v = 0.0;
            out.ch[c][f] = v;
        }
    }
    return true;
}

inline WavIrData ResampleWavIrSinc(const WavIrData& src, uint32_t targetRate) {
    if (src.sampleRate == 0 || targetRate == 0 || src.sampleRate == targetRate || src.frameCount == 0) {
        return src;
    }
    const double ratio = static_cast<double>(targetRate) / static_cast<double>(src.sampleRate);
    const size_t dstFrames = std::max<size_t>(1, static_cast<size_t>(std::llround(static_cast<double>(src.frameCount) * ratio)));
    WavIrData dst{};
    dst.sampleRate = targetRate;
    dst.channels = src.channels;
    dst.frameCount = dstFrames;
    dst.ch.assign(src.channels, std::vector<double>(dstFrames, 0.0));

    constexpr int kHalfWidth = 32;
    const double cutoff = std::min(1.0, ratio) * 0.94;
    const double gainScale = ratio < 1.0 ? cutoff : (cutoff / ratio);

    for (uint16_t c = 0; c < src.channels; ++c) {
        const auto& sVec = src.ch[c];
        auto& dVec = dst.ch[c];
        for (size_t i = 0; i < dstFrames; ++i) {
            const double center = static_cast<double>(i) / ratio;
            const int iCenter = static_cast<int>(std::floor(center));
            double acc = 0.0;
            for (int k = -kHalfWidth; k <= kHalfWidth; ++k) {
                const int idx = iCenter + k;
                if (idx < 0 || idx >= static_cast<int>(src.frameCount)) continue;
                const double x = center - static_cast<double>(idx);
                const double sinc = (std::fabs(x) < 1e-12)
                    ? 1.0
                    : std::sin(kPi * cutoff * x) / (kPi * cutoff * x);
                const double wNorm = (static_cast<double>(k) + (center - iCenter) + kHalfWidth) / static_cast<double>(2 * kHalfWidth);
                const double win = 0.35875 - 0.48829 * std::cos(2.0 * kPi * wNorm) +
                                   0.14128 * std::cos(4.0 * kPi * wNorm) -
                                   0.01168 * std::cos(6.0 * kPi * wNorm);
                acc += sVec[static_cast<size_t>(idx)] * sinc * win;
            }
            dVec[i] = acc * gainScale;
        }
    }
    return dst;
}

struct IrFilterSpectrum64 {
    bool active = false;
    std::vector<double> headTaps; // up to kPartSize taps, zero-trimmed
    std::vector<std::vector<Complex64>> tailPartSpectra; // [partition][kHalfBins]

    void Prepare(const std::vector<double>& ir) {
        active = false;
        headTaps.clear();
        tailPartSpectra.clear();
        if (ir.empty()) return;

        size_t effLen = ir.size();
        while (effLen > 0 && std::fabs(ir[effLen - 1]) < 1e-15) {
            --effLen;
        }
        if (effLen == 0) return;
        active = true;

        const size_t headCount = std::min(effLen, kPartSize);
        headTaps.assign(ir.begin(), ir.begin() + headCount);
        while (!headTaps.empty() && std::fabs(headTaps.back()) < 1e-15) {
            headTaps.pop_back();
        }

        if (effLen > kPartSize) {
            const size_t rem = effLen - kPartSize;
            const size_t numParts = (rem + kPartSize - 1) / kPartSize;
            tailPartSpectra.reserve(numParts);
            std::vector<Complex64> fftBuf(kFftSize);
            for (size_t p = 0; p < numParts; ++p) {
                std::fill(fftBuf.begin(), fftBuf.end(), Complex64{});
                const size_t offset = kPartSize + p * kPartSize;
                const size_t copyLen = std::min(kPartSize, effLen - offset);
                for (size_t i = 0; i < copyLen; ++i) {
                    fftBuf[i].re = ir[offset + i];
                }
                FftInPlace(fftBuf, false);
                tailPartSpectra.emplace_back(fftBuf.begin(), fftBuf.begin() + kHalfBins);
            }
        }
    }
};

struct ConvolverSlot64 {
    bool enabled = false;
    uint32_t sampleRate = 48000;
    size_t tapCount = 0;
    bool trueStereo = false;
    std::atomic<double> wetMix{1.0};

    IrFilterSpectrum64 fltLL;
    IrFilterSpectrum64 fltLR;
    IrFilterSpectrum64 fltRL;
    IrFilterSpectrum64 fltRR;

    // Runtime state (zero allocation inside audio render loop)
    double inHistory[2][kFftSize] = {};
    double tailOut[2][kPartSize] = {};
    size_t blockPos = 0;
    size_t maxPartitions = 0;
    size_t fdlCursor = 0;
    std::vector<std::vector<Complex64>> fdlL;
    std::vector<std::vector<Complex64>> fdlR;
    std::vector<Complex64> scratchFft;
    std::vector<Complex64> scratchAccumL;
    std::vector<Complex64> scratchAccumR;

    void ClearRuntimeState() {
        std::memset(inHistory, 0, sizeof(inHistory));
        std::memset(tailOut, 0, sizeof(tailOut));
        blockPos = 0;
        fdlCursor = 0;
        for (auto& v : fdlL) std::fill(v.begin(), v.end(), Complex64{});
        for (auto& v : fdlR) std::fill(v.begin(), v.end(), Complex64{});
        std::fill(scratchFft.begin(), scratchFft.end(), Complex64{});
        std::fill(scratchAccumL.begin(), scratchAccumL.end(), Complex64{});
        std::fill(scratchAccumR.begin(), scratchAccumR.end(), Complex64{});
    }

    bool Prepare(const WavIrData& rawIr, uint32_t targetRate, double wet01) {
        enabled = false;
        sampleRate = targetRate > 0 ? targetRate : 48000u;
        wetMix.store(std::clamp(wet01, 0.0, 1.0), std::memory_order_relaxed);
        fltLL = IrFilterSpectrum64{};
        fltLR = IrFilterSpectrum64{};
        fltRL = IrFilterSpectrum64{};
        fltRR = IrFilterSpectrum64{};

        if (rawIr.frameCount == 0 || rawIr.channels == 0) return false;
        WavIrData resampled = (rawIr.sampleRate == sampleRate) ? rawIr : ResampleWavIrSinc(rawIr, sampleRate);
        tapCount = resampled.frameCount;

        if (resampled.channels == 1) {
            fltLL.Prepare(resampled.ch[0]);
            fltRR.Prepare(resampled.ch[0]);
            trueStereo = false;
        } else if (resampled.channels == 2) {
            fltLL.Prepare(resampled.ch[0]);
            fltRR.Prepare(resampled.ch[1]);
            trueStereo = false;
        } else if (resampled.channels >= 4) {
            fltLL.Prepare(resampled.ch[0]);
            fltLR.Prepare(resampled.ch[1]);
            fltRL.Prepare(resampled.ch[2]);
            fltRR.Prepare(resampled.ch[3]);
            trueStereo = fltLR.active || fltRL.active;
        }

        maxPartitions = std::max({
            fltLL.tailPartSpectra.size(),
            fltLR.tailPartSpectra.size(),
            fltRL.tailPartSpectra.size(),
            fltRR.tailPartSpectra.size()
        });

        fdlL.assign(maxPartitions, std::vector<Complex64>(kHalfBins));
        fdlR.assign(maxPartitions, std::vector<Complex64>(kHalfBins));
        scratchFft.assign(kFftSize, Complex64{});
        scratchAccumL.assign(kFftSize, Complex64{});
        scratchAccumR.assign(kFftSize, Complex64{});
        ClearRuntimeState();
        enabled = fltLL.active || fltRR.active;
        return enabled;
    }

    static inline double EvalHeadFir(const double* hist, size_t curIdx, const std::vector<double>& taps) {
        const size_t n = taps.size();
        const double* tPtr = taps.data();
        const double* hPtr = hist + curIdx;
        double sum = 0.0;
        for (size_t k = 0; k < n; ++k) {
            sum += tPtr[k] * hPtr[-static_cast<ptrdiff_t>(k)];
        }
        return sum;
    }

    inline void ComputeNextTailBlock() {
        if (maxPartitions == 0) return;

        // Forward FFT of [prevBlock, curBlock] for L
        for (size_t i = 0; i < kFftSize; ++i) {
            scratchFft[i].re = inHistory[0][i];
            scratchFft[i].im = 0.0;
        }
        FftInPlace(scratchFft, false);
        std::memcpy(fdlL[fdlCursor].data(), scratchFft.data(), kHalfBins * sizeof(Complex64));

        // Forward FFT of [prevBlock, curBlock] for R
        for (size_t i = 0; i < kFftSize; ++i) {
            scratchFft[i].re = inHistory[1][i];
            scratchFft[i].im = 0.0;
        }
        FftInPlace(scratchFft, false);
        std::memcpy(fdlR[fdlCursor].data(), scratchFft.data(), kHalfBins * sizeof(Complex64));

        std::fill(scratchAccumL.begin(), scratchAccumL.end(), Complex64{});
        std::fill(scratchAccumR.begin(), scratchAccumR.end(), Complex64{});

        auto macPartition = [&](const std::vector<std::vector<Complex64>>& fdl, const IrFilterSpectrum64& flt, std::vector<Complex64>& accum) {
            const size_t pCount = flt.tailPartSpectra.size();
            for (size_t p = 0; p < pCount; ++p) {
                const size_t slotIdx = (fdlCursor + maxPartitions - p) % maxPartitions;
                const Complex64* x = fdl[slotIdx].data();
                const Complex64* h = flt.tailPartSpectra[p].data();
                for (size_t k = 0; k < kHalfBins; ++k) {
                    const double xr = x[k].re;
                    const double xi = x[k].im;
                    const double hr = h[k].re;
                    const double hi = h[k].im;
                    accum[k].re += xr * hr - xi * hi;
                    accum[k].im += xr * hi + xi * hr;
                }
            }
        };

        macPartition(fdlL, fltLL, scratchAccumL);
        macPartition(fdlR, fltRR, scratchAccumR);
        if (trueStereo) {
            macPartition(fdlR, fltRL, scratchAccumL);
            macPartition(fdlL, fltLR, scratchAccumR);
        }

        // Reconstruct Hermitian symmetry and run Inverse FFT for L & R tails
        auto finishTail = [&](std::vector<Complex64>& accum, double* outBuf) {
            for (size_t k = 1; k < kFftSize / 2; ++k) {
                accum[kFftSize - k].re = accum[k].re;
                accum[kFftSize - k].im = -accum[k].im;
            }
            FftInPlace(accum, true);
            for (size_t i = 0; i < kPartSize; ++i) {
                outBuf[i] = accum[kPartSize + i].re;
            }
        };

        finishTail(scratchAccumL, tailOut[0]);
        finishTail(scratchAccumR, tailOut[1]);

        fdlCursor = (fdlCursor + 1) % maxPartitions;
    }

    // Audio-thread hot path: ZERO heap allocations, ZERO mutexes!
    inline void ProcessStereoFrame(double& sampleL, double& sampleR) {
        if (!enabled) return;

        const double dryL = sampleL;
        const double dryR = sampleR;
        const size_t curIdx = kPartSize + blockPos;
        inHistory[0][curIdx] = dryL;
        inHistory[1][curIdx] = dryR;

        double wetL = EvalHeadFir(inHistory[0], curIdx, fltLL.headTaps) + tailOut[0][blockPos];
        double wetR = EvalHeadFir(inHistory[1], curIdx, fltRR.headTaps) + tailOut[1][blockPos];
        if (trueStereo) {
            wetL += EvalHeadFir(inHistory[1], curIdx, fltRL.headTaps);
            wetR += EvalHeadFir(inHistory[0], curIdx, fltLR.headTaps);
        }

        const double w = wetMix.load(std::memory_order_relaxed);
        const double d = 1.0 - w;
        sampleL = dryL * d + wetL * w;
        sampleR = dryR * d + wetR * w;

        ++blockPos;
        if (blockPos >= kPartSize) {
            ComputeNextTailBlock();
            std::memmove(inHistory[0], inHistory[0] + kPartSize, kPartSize * sizeof(double));
            std::memmove(inHistory[1], inHistory[1] + kPartSize, kPartSize * sizeof(double));
            blockPos = 0;
        }
    }
};

// Wait-free triple-buffered convolver host allowing instant lock-free hot-swaps from control thread.
class ConvolverHost64 {
public:
    ConvolverHost64() {
        for (int i = 0; i < 3; ++i) {
            m_slots[i] = std::make_unique<ConvolverSlot64>();
        }
    }

    bool LoadFromFile(const std::string& utf8Path, uint32_t targetRate, double wet01, const std::wstring& wPath, std::string& outErr, size_t* outTapCount = nullptr) {
        (void)utf8Path;
        WavIrData wav;
        if (!LoadWavIrFromFile(wPath, wav, outErr)) {
            return false;
        }
        return LoadFromWavData(wav, targetRate, wet01, outErr, outTapCount);
    }

    bool LoadFromWavData(const WavIrData& wav, uint32_t targetRate, double wet01, std::string& outErr, size_t* outTapCount = nullptr) {
        const int pub = m_publishedSlot.load(std::memory_order_acquire);
        const int ren = m_renderSlot.load(std::memory_order_acquire);
        int freeIdx = -1;
        for (int i = 0; i < 3; ++i) {
            if (i != pub && i != ren) {
                freeIdx = i;
                break;
            }
        }
        if (freeIdx < 0) freeIdx = (pub == 0 ? 1 : 0);

        if (!m_slots[freeIdx]->Prepare(wav, targetRate, wet01)) {
            outErr = "Convolver IR contains no non-zero taps";
            return false;
        }
        if (outTapCount) *outTapCount = m_slots[freeIdx]->tapCount;
        m_wetMixAtomic.store(std::clamp(wet01, 0.0, 1.0), std::memory_order_relaxed);
        m_publishedSlot.store(freeIdx, std::memory_order_release);
        return true;
    }

    void Disable() {
        m_publishedSlot.store(-1, std::memory_order_release);
    }

    void SetWetMix(double wet01) {
        const double clamped = std::clamp(wet01, 0.0, 1.0);
        m_wetMixAtomic.store(clamped, std::memory_order_relaxed);
        const int pub = m_publishedSlot.load(std::memory_order_acquire);
        if (pub >= 0 && pub < 3 && m_slots[pub]) {
            m_slots[pub]->wetMix.store(clamped, std::memory_order_relaxed);
        }
    }

    bool IsActive() const {
        return m_publishedSlot.load(std::memory_order_acquire) >= 0;
    }

    double GetWetMix() const {
        return m_wetMixAtomic.load(std::memory_order_relaxed);
    }

    // Audio render thread ONLY: locks slot via atomic exchange index without blocking.
    inline ConvolverSlot64* AcquireActiveForRender() {
        const int pub = m_publishedSlot.load(std::memory_order_acquire);
        m_renderSlot.store(pub, std::memory_order_seq_cst);
        const double w = m_wetMixAtomic.load(std::memory_order_relaxed);
        if (pub >= 0 && pub < 3 && m_slots[pub] && m_slots[pub]->enabled) {
            m_slots[pub]->wetMix.store(w, std::memory_order_relaxed);
            return m_slots[pub].get();
        }
        return nullptr;
    }

    inline void ReleaseRenderSlot() {
        m_renderSlot.store(-1, std::memory_order_release);
    }

private:
    std::unique_ptr<ConvolverSlot64> m_slots[3];
    std::atomic<int> m_publishedSlot{-1};
    std::atomic<int> m_renderSlot{-1};
    std::atomic<double> m_wetMixAtomic{1.0};
};

} // namespace vanta_convolver
