#pragma once

// Clean-room ScarletBook SACD ISO (.iso) TOC & DSD/DST Sector Reader for VANTA.
// Reads Master TOC (LSN 510), TWOCHTOC / MULCHTOC Area TOCs, SACDTRL1 / SACDTRL2,
// SACDTTxt titles, and extracts uncompressed DSD or DST compressed frames into
// standard Philips DSDIFF (FRM8 / DSD ) streams for native playback or FFmpeg DST decode.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

namespace vanta_sacd {

constexpr uint64_t kSacdSectorPayloadSize = 2048ULL;
constexpr uint64_t kSacdMasterTocLsn = 510ULL;

inline uint16_t ReadBe16(const uint8_t* p) {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | static_cast<uint16_t>(p[1]));
}

inline uint32_t ReadBe32(const uint8_t* p) {
    return (static_cast<uint32_t>(p[0]) << 24) |
           (static_cast<uint32_t>(p[1]) << 16) |
           (static_cast<uint32_t>(p[2]) << 8) |
           static_cast<uint32_t>(p[3]);
}

inline void WriteBe16(std::vector<uint8_t>& out, uint16_t v) {
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xFFu));
    out.push_back(static_cast<uint8_t>(v & 0xFFu));
}

inline void WriteBe32(std::vector<uint8_t>& out, uint32_t v) {
    out.push_back(static_cast<uint8_t>((v >> 24) & 0xFFu));
    out.push_back(static_cast<uint8_t>((v >> 16) & 0xFFu));
    out.push_back(static_cast<uint8_t>((v >> 8) & 0xFFu));
    out.push_back(static_cast<uint8_t>(v & 0xFFu));
}

inline void WriteBe64(std::vector<uint8_t>& out, uint64_t v) {
    WriteBe32(out, static_cast<uint32_t>((v >> 32) & 0xFFFFFFFFu));
    WriteBe32(out, static_cast<uint32_t>(v & 0xFFFFFFFFu));
}

inline std::wstring Utf8ToWideSacd(const std::string& s) {
    if (s.empty()) return L"";
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    if (n <= 1) return L"";
    std::wstring out(static_cast<size_t>(n - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
    return out;
}

inline std::string TrimAsciiClean(const uint8_t* p, size_t len) {
    size_t actual = 0;
    while (actual < len && p[actual] != '\0') ++actual;
    std::string s(reinterpret_cast<const char*>(p), actual);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n')) s.pop_back();
    size_t start = 0;
    while (start < s.size() && (s[start] == ' ' || s[start] == '\t')) ++start;
    return s.substr(start);
}

struct SacdTrackInfo {
    uint32_t trackNumber = 1; // 1-based
    uint32_t areaIndex = 0;
    std::string title;
    std::string artist;
    uint32_t startLsn = 0;
    uint32_t lengthLsn = 0;
    double durationSec = 0.0;
    uint16_t channels = 2;
    uint32_t sampleRate = 2822400;
    bool isDst = false;
};

struct SacdAreaInfo {
    uint32_t areaIndex = 0;
    std::string areaName; // "2ch Stereo" or "Multi-Channel"
    uint32_t tocStartLsn = 0;
    uint16_t tocSizeSectors = 0;
    uint32_t sampleRate = 2822400;
    uint16_t channels = 2;
    uint8_t frameFormat = 2; // 0 = DST, 2/3 = raw DSD
    bool isDst = false;
    std::vector<SacdTrackInfo> tracks;
};

struct SacdDiscInfo {
    bool ok = false;
    uint64_t sectorStride = 2048ULL;
    uint64_t sectorHeaderSkip = 0ULL;
    std::string albumCatalogNumber;
    std::vector<SacdAreaInfo> areas;
    std::string errorMessage;
};

class SacdIsoReader final {
public:
    ~SacdIsoReader() {
        Close();
    }

    void Close() {
        if (m_fp) {
            std::fclose(m_fp);
            m_fp = nullptr;
        }
    }

    bool Open(const std::string& isoPath, std::string& outErr) {
        Close();
        const std::wstring wPath = Utf8ToWideSacd(isoPath);
        if (_wfopen_s(&m_fp, wPath.c_str(), L"rb") != 0 || !m_fp) {
            outErr = "Unable to open SACD ISO file";
            return false;
        }

        uint8_t sec[2048] = {};
        if (ReadSectorAt(kSacdMasterTocLsn, 2048ULL, 0ULL, sec) && std::memcmp(sec, "SACDMTOC", 8) == 0) {
            m_info.sectorStride = 2048ULL;
            m_info.sectorHeaderSkip = 0ULL;
        } else if (ReadSectorAt(kSacdMasterTocLsn, 2064ULL, 12ULL, sec) && std::memcmp(sec, "SACDMTOC", 8) == 0) {
            m_info.sectorStride = 2064ULL;
            m_info.sectorHeaderSkip = 12ULL;
        } else {
            outErr = "Invalid SACD ISO image (SACDMTOC signature missing at LSN 510)";
            Close();
            return false;
        }

        m_info.albumCatalogNumber = TrimAsciiClean(sec + 24, 16);
        const uint32_t area1Start = ReadBe32(sec + 64);
        const uint32_t area2Start = ReadBe32(sec + 72);
        const uint16_t area1Size = ReadBe16(sec + 84);
        const uint16_t area2Size = ReadBe16(sec + 86);

        m_info.areas.clear();
        if (area1Start > 0 && area1Size > 0) {
            SacdAreaInfo a0{};
            if (ParseAreaToc(0, area1Start, area1Size, a0)) {
                m_info.areas.push_back(std::move(a0));
            }
        }
        if (area2Start > 0 && area2Size > 0) {
            SacdAreaInfo a1{};
            if (ParseAreaToc(1, area2Start, area2Size, a1)) {
                m_info.areas.push_back(std::move(a1));
            }
        }

        if (m_info.areas.empty()) {
            outErr = "SACD ISO contains no readable TWOCHTOC or MULCHTOC audio area";
            Close();
            return false;
        }

        m_info.ok = true;
        return true;
    }

    const SacdDiscInfo& DiscInfo() const { return m_info; }

    // Extracts a single SACD track and streams a valid Philips DSDIFF (FRM8 / DSD ) stream via sink.
    // Uses a lock-free two-pass read over track sectors so DST & DSD chunk headers carry exact byte lengths.
    bool StreamTrackAsDsdiff(
        uint32_t areaIndex,
        uint32_t trackNumber1Based,
        const std::function<bool(const uint8_t* data, size_t len)>& emitChunk,
        std::string& outErr) {
        if (!m_fp || !m_info.ok) {
            outErr = "SACD ISO is not open";
            return false;
        }

        const SacdAreaInfo* areaPtr = nullptr;
        for (const auto& a : m_info.areas) {
            if (a.areaIndex == areaIndex) {
                areaPtr = &a;
                break;
            }
        }
        if (!areaPtr) {
            areaPtr = &m_info.areas.front();
        }

        const SacdTrackInfo* trackPtr = nullptr;
        for (const auto& t : areaPtr->tracks) {
            if (t.trackNumber == trackNumber1Based) {
                trackPtr = &t;
                break;
            }
        }
        if (!trackPtr || trackPtr->lengthLsn == 0) {
            outErr = "Requested track not found in SACD area";
            return false;
        }

        const uint32_t ch = areaPtr->channels > 0 ? areaPtr->channels : 2u;
        const uint32_t fs = areaPtr->sampleRate > 0 ? areaPtr->sampleRate : 2822400u;

        // Pass 1: determine exact frame & byte counts (supports both DST compressed and raw DSD packets)
        uint64_t totalDstChunkPayload = 0;
        uint32_t dstFrameCount = 0;
        uint64_t totalRawDsdBytes = 0;
        bool sawAnyDstFrame = areaPtr->isDst;

        auto collectTrackFrames = [&](const std::function<bool(const std::vector<uint8_t>& frameBuf, bool isDstFrame)>& onFrame) -> bool {
            std::vector<uint8_t> curFrame;
            bool curFrameIsDst = areaPtr->isDst;
            bool haveStartedFrame = false;
            std::vector<uint8_t> sec(static_cast<size_t>(kSacdSectorPayloadSize));

            for (uint32_t rel = 0; rel < trackPtr->lengthLsn; ++rel) {
                if (!ReadSector(trackPtr->startLsn + rel, sec.data())) {
                    break;
                }
                const uint8_t hdr = sec[0];
                const uint8_t pktCount = (hdr >> 5) & 0x07u;
                const uint8_t frmCount = (hdr >> 2) & 0x07u;
                const bool dstEnc = (hdr & 0x01u) != 0;
                if (pktCount == 0 || pktCount > 7 || frmCount > 7) continue;

                // Determine exact payload offset cleanly after packet_info + frame_info entries
                size_t totalPktLen = 0;
                struct PktDesc { bool frameStart; uint8_t dataType; uint16_t len; };
                PktDesc pkts[7] = {};
                for (uint8_t pi = 0; pi < pktCount; ++pi) {
                    const uint16_t w = ReadBe16(sec.data() + 1u + static_cast<size_t>(pi) * 2u);
                    pkts[pi].frameStart = ((w >> 15) & 0x01u) != 0;
                    pkts[pi].dataType = static_cast<uint8_t>((w >> 11) & 0x07u);
                    pkts[pi].len = static_cast<uint16_t>(w & 0x07FFu);
                    totalPktLen += pkts[pi].len;
                }

                // Standard ScarletBook audio sector layout uses 4-byte frame_info slots when DST,
                // or 3-byte timecode slots when raw DSD (fallback to 4 if bounds fit cleanly).
                const size_t hdrBase = 1u + static_cast<size_t>(pktCount) * 2u;
                size_t payloadCursor = hdrBase + static_cast<size_t>(frmCount) * (dstEnc ? 4u : 3u);
                if (payloadCursor + totalPktLen > kSacdSectorPayloadSize && hdrBase + static_cast<size_t>(frmCount) * 4u + totalPktLen <= kSacdSectorPayloadSize) {
                    payloadCursor = hdrBase + static_cast<size_t>(frmCount) * 4u;
                }
                if (payloadCursor + totalPktLen > kSacdSectorPayloadSize) {
                    continue;
                }

                for (uint8_t pi = 0; pi < pktCount; ++pi) {
                    const PktDesc& pd = pkts[pi];
                    const size_t pLen = pd.len;
                    if (payloadCursor + pLen > kSacdSectorPayloadSize) break;
                    if (pd.dataType == 2u /* DATA_TYPE_AUDIO */ && pLen > 0) {
                        if (pd.frameStart) {
                            if (haveStartedFrame && !curFrame.empty()) {
                                if (!onFrame(curFrame, curFrameIsDst)) return false;
                            }
                            curFrame.clear();
                            curFrameIsDst = dstEnc;
                            haveStartedFrame = true;
                        }
                        if (!haveStartedFrame) {
                            curFrame.clear();
                            curFrameIsDst = dstEnc;
                            haveStartedFrame = true;
                        }
                        curFrame.insert(curFrame.end(), sec.data() + payloadCursor, sec.data() + payloadCursor + pLen);
                    }
                    payloadCursor += pLen;
                }
            }
            if (haveStartedFrame && !curFrame.empty()) {
                if (!onFrame(curFrame, curFrameIsDst)) return false;
            }
            return true;
        };

        collectTrackFrames([&](const std::vector<uint8_t>& frameBuf, bool isDstFrame) -> bool {
            if (isDstFrame) sawAnyDstFrame = true;
            if (sawAnyDstFrame) {
                const uint64_t pad = frameBuf.size() & 1ULL;
                totalDstChunkPayload += 12ULL /* "DSTF" + uint64 len */ + frameBuf.size() + pad;
                ++dstFrameCount;
            } else {
                totalRawDsdBytes += frameBuf.size();
            }
            return true;
        });

        if ((sawAnyDstFrame && dstFrameCount == 0) || (!sawAnyDstFrame && totalRawDsdBytes == 0)) {
            outErr = "SACD track contains no audio frames";
            return false;
        }

        // Build DSDIFF PROP chunk
        std::vector<uint8_t> propSub;
        // "SND "
        propSub.insert(propSub.end(), {'S', 'N', 'D', ' '});
        // "FS  "
        propSub.insert(propSub.end(), {'F', 'S', ' ', ' '});
        WriteBe64(propSub, 4ULL);
        WriteBe32(propSub, fs);
        // "CHNL"
        propSub.insert(propSub.end(), {'C', 'H', 'N', 'L'});
        WriteBe64(propSub, 2ULL + static_cast<uint64_t>(ch) * 4ULL);
        WriteBe16(propSub, static_cast<uint16_t>(ch));
        static const char kChIds[6][4] = {
            {'S', 'L', 'F', 'T'},
            {'S', 'R', 'G', 'T'},
            {'C', ' ', ' ', ' '},
            {'L', 'F', 'E', ' '},
            {'L', 'S', ' ', ' '},
            {'R', 'S', ' ', ' '}
        };
        for (uint32_t c = 0; c < ch; ++c) {
            const char* cid = (c < 6) ? kChIds[c] : kChIds[0];
            propSub.insert(propSub.end(), cid, cid + 4);
        }
        // "CMPR"
        const char* cmprTag = sawAnyDstFrame ? "DST " : "DSD ";
        const char* cmprLabel = sawAnyDstFrame ? "DST Encoded" : "not compressed";
        const uint8_t labelLen = static_cast<uint8_t>(std::strlen(cmprLabel));
        const uint64_t cmprRawSize = 5ULL + labelLen;
        const uint64_t cmprPad = cmprRawSize & 1ULL;
        propSub.insert(propSub.end(), {'C', 'M', 'P', 'R'});
        WriteBe64(propSub, cmprRawSize);
        propSub.insert(propSub.end(), cmprTag, cmprTag + 4);
        propSub.push_back(labelLen);
        propSub.insert(propSub.end(), cmprLabel, cmprLabel + labelLen);
        if (cmprPad) propSub.push_back(0);

        std::vector<uint8_t> hdrBuf;
        const uint64_t fverChunkBytes = 16ULL;
        const uint64_t propChunkBytes = 12ULL + propSub.size();
        const uint64_t frteSectionBytes = sawAnyDstFrame ? (12ULL + 6ULL) : 0ULL;
        const uint64_t audioDataPayload = sawAnyDstFrame ? (frteSectionBytes + totalDstChunkPayload) : totalRawDsdBytes;
        const uint64_t audioPad = audioDataPayload & 1ULL;
        const uint64_t frm8Size = 4ULL + fverChunkBytes + propChunkBytes + 12ULL + audioDataPayload + audioPad;

        hdrBuf.insert(hdrBuf.end(), {'F', 'R', 'M', '8'});
        WriteBe64(hdrBuf, frm8Size);
        hdrBuf.insert(hdrBuf.end(), {'D', 'S', 'D', ' '});

        hdrBuf.insert(hdrBuf.end(), {'F', 'V', 'E', 'R'});
        WriteBe64(hdrBuf, 4ULL);
        WriteBe32(hdrBuf, 0x01050000u);

        hdrBuf.insert(hdrBuf.end(), {'P', 'R', 'O', 'P'});
        WriteBe64(hdrBuf, propSub.size());
        hdrBuf.insert(hdrBuf.end(), propSub.begin(), propSub.end());

        if (sawAnyDstFrame) {
            hdrBuf.insert(hdrBuf.end(), {'D', 'S', 'T', ' '});
            WriteBe64(hdrBuf, audioDataPayload);
            hdrBuf.insert(hdrBuf.end(), {'F', 'R', 'T', 'E'});
            WriteBe64(hdrBuf, 6ULL);
            WriteBe32(hdrBuf, dstFrameCount);
            WriteBe16(hdrBuf, 75u);
        } else {
            hdrBuf.insert(hdrBuf.end(), {'D', 'S', 'D', ' '});
            WriteBe64(hdrBuf, totalRawDsdBytes);
        }

        if (!emitChunk(hdrBuf.data(), hdrBuf.size())) {
            outErr = "Failed writing DSDIFF header";
            return false;
        }

        // Pass 2: stream audio chunks directly with minimal heap overhead
        const bool streamOk = collectTrackFrames([&](const std::vector<uint8_t>& frameBuf, bool /*isDstFrame*/) -> bool {
            if (sawAnyDstFrame) {
                std::vector<uint8_t> dstHdr;
                dstHdr.reserve(12);
                dstHdr.insert(dstHdr.end(), {'D', 'S', 'T', 'F'});
                WriteBe64(dstHdr, frameBuf.size());
                if (!emitChunk(dstHdr.data(), dstHdr.size())) return false;
                if (!emitChunk(frameBuf.data(), frameBuf.size())) return false;
                if (frameBuf.size() & 1u) {
                    const uint8_t z = 0;
                    if (!emitChunk(&z, 1)) return false;
                }
            } else {
                if (!emitChunk(frameBuf.data(), frameBuf.size())) return false;
            }
            return true;
        });

        if (streamOk && audioPad) {
            const uint8_t z = 0;
            emitChunk(&z, 1);
        }
        return streamOk;
    }

private:
    bool ReadSectorAt(uint64_t lsn, uint64_t stride, uint64_t skip, uint8_t* dst2048) {
        if (!m_fp) return false;
        const __int64 off = static_cast<__int64>(lsn * stride + skip);
        if (_fseeki64(m_fp, off, SEEK_SET) != 0) return false;
        return std::fread(dst2048, 1, kSacdSectorPayloadSize, m_fp) == kSacdSectorPayloadSize;
    }

    bool ReadSector(uint64_t lsn, uint8_t* dst2048) {
        return ReadSectorAt(lsn, m_info.sectorStride, m_info.sectorHeaderSkip, dst2048);
    }

    bool ParseAreaToc(uint32_t areaIdx, uint32_t startLsn, uint16_t tocSectors, SacdAreaInfo& outArea) {
        const size_t safeSectors = std::min<size_t>(tocSectors, 64u);
        std::vector<uint8_t> tocBuf(safeSectors * kSacdSectorPayloadSize, 0);
        for (size_t s = 0; s < safeSectors; ++s) {
            if (!ReadSector(startLsn + static_cast<uint32_t>(s), tocBuf.data() + s * kSacdSectorPayloadSize)) {
                return false;
            }
        }

        if (std::memcmp(tocBuf.data(), "TWOCHTOC", 8) != 0 && std::memcmp(tocBuf.data(), "MULCHTOC", 8) != 0) {
            return false;
        }

        outArea.areaIndex = areaIdx;
        outArea.areaName = (std::memcmp(tocBuf.data(), "MULCHTOC", 8) == 0) ? "Multi-Channel" : "2ch Stereo";
        outArea.tocStartLsn = startLsn;
        outArea.tocSizeSectors = tocSectors;

        const uint8_t sfCode = tocBuf[20];
        outArea.sampleRate = (sfCode == 5u) ? 5644800u : 2822400u;
        outArea.frameFormat = static_cast<uint8_t>(tocBuf[21] & 0x0Fu);
        outArea.isDst = (outArea.frameFormat == 0u);
        outArea.channels = std::max<uint16_t>(1u, static_cast<uint16_t>(tocBuf[32] > 0 ? tocBuf[32] : (areaIdx == 0 ? 2 : 6)));

        const uint8_t* trl1 = nullptr;
        const uint8_t* trl2 = nullptr;
        const uint8_t* ttxt = nullptr;
        size_t ttxtMaxBytes = 0;

        for (size_t s = 0; s < safeSectors; ++s) {
            const uint8_t* p = tocBuf.data() + s * kSacdSectorPayloadSize;
            if (!trl1 && std::memcmp(p, "SACDTRL1", 8) == 0 && (s * kSacdSectorPayloadSize + 8 + 255 * 8) <= tocBuf.size()) {
                trl1 = p;
            } else if (!trl2 && std::memcmp(p, "SACDTRL2", 8) == 0 && (s * kSacdSectorPayloadSize + 8 + 255 * 8) <= tocBuf.size()) {
                trl2 = p;
            } else if (!ttxt && std::memcmp(p, "SACDTTxt", 8) == 0) {
                ttxt = p;
                ttxtMaxBytes = tocBuf.size() - s * kSacdSectorPayloadSize;
            }
        }

        if (!trl1) return false;

        std::vector<uint32_t> startLsns(255, 0);
        std::vector<uint32_t> lenLsns(255, 0);
        uint32_t detectedTracks = 0;
        for (uint32_t i = 0; i < 255; ++i) {
            startLsns[i] = ReadBe32(trl1 + 8 + i * 4);
            lenLsns[i] = ReadBe32(trl1 + 8 + 255 * 4 + i * 4);
            if (lenLsns[i] > 0 && startLsns[i] > 0) {
                detectedTracks = i + 1;
            } else if (detectedTracks > 0) {
                break;
            }
        }
        if (detectedTracks == 0) return false;

        outArea.tracks.clear();
        for (uint32_t i = 0; i < detectedTracks; ++i) {
            SacdTrackInfo trk{};
            trk.trackNumber = i + 1;
            trk.areaIndex = areaIdx;
            trk.startLsn = startLsns[i];
            trk.lengthLsn = lenLsns[i];
            trk.channels = outArea.channels;
            trk.sampleRate = outArea.sampleRate;
            trk.isDst = outArea.isDst;

            if (trl2) {
                // duration entry starts at trl2 + 8 + 255*4 + i*4: minutes(0), seconds(1), frames(2) (1/75s)
                const uint8_t* dur = trl2 + 8 + 255 * 4 + i * 4;
                trk.durationSec = static_cast<double>(dur[0]) * 60.0 + static_cast<double>(dur[1]) + static_cast<double>(dur[2]) / 75.0;
            }
            if (trk.durationSec <= 0.0 && trk.lengthLsn > 0) {
                // Rough fallback duration (~750 sectors/sec uncompressed stereo DSD64)
                trk.durationSec = static_cast<double>(trk.lengthLsn) / 750.0;
            }

            if (ttxt && (8 + i * 2 + 2) <= ttxtMaxBytes) {
                const uint16_t relPos = ReadBe16(ttxt + 8 + i * 2);
                if (relPos > 0 && static_cast<size_t>(relPos) + 4 < ttxtMaxBytes) {
                    const uint8_t* entry = ttxt + relPos;
                    const size_t avail = ttxtMaxBytes - relPos;
                    // ScarletBook track text entries: itemCount (byte 0..1 or direct tagged items [typeByte, str...\0])
                    size_t cur = 0;
                    if (avail >= 2 && entry[0] == 0x00 && entry[1] >= 0x01 && entry[1] <= 0x0E) {
                        cur = 1;
                    }
                    for (int item = 0; item < 6 && cur + 2 < avail; ++item) {
                        const uint8_t itemType = entry[cur++];
                        if (itemType == 0x00) break;
                        const char* strPtr = reinterpret_cast<const char*>(entry + cur);
                        const size_t maxLen = avail - cur;
                        size_t sLen = 0;
                        while (sLen < maxLen && strPtr[sLen] != '\0') ++sLen;
                        if (itemType == 0x01 && trk.title.empty()) {
                            trk.title.assign(strPtr, sLen);
                        } else if (itemType == 0x02 && trk.artist.empty()) {
                            trk.artist.assign(strPtr, sLen);
                        }
                        cur += sLen + (sLen < maxLen ? 1u : 0u);
                    }
                }
            }
            if (trk.title.empty()) {
                trk.title = "SACD Track " + std::to_string(trk.trackNumber);
            }
            outArea.tracks.push_back(std::move(trk));
        }

        return !outArea.tracks.empty();
    }

    FILE* m_fp = nullptr;
    SacdDiscInfo m_info{};
};

} // namespace vanta_sacd
