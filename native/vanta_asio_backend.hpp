#pragma once

// Clean-room Windows COM ABI & Registry ASIO backend for VANTA.
// Enumerates HKLM\SOFTWARE\ASIO\* and communicates with ASIO drivers strictly
// inside the isolated vanta-audio-engine.exe subprocess (zero Steinberg SDK headers).

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <objbase.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "advapi32.lib")

namespace vanta_asio {

#pragma pack(push, 4)

struct AsioSamples64 {
    unsigned long hi = 0;
    unsigned long lo = 0;
};

using AsioSampleRate = double;
using AsioBool = long;
using AsioError = long;
using AsioSampleType = long;

enum : AsioError {
    kAseOk = 0,
    kAseSuccess = 0x3f4847a0L,
    kAseNotPresent = -1000,
    kAseHwMalfunction = -999,
    kAseInvalidParameter = -998,
    kAseInvalidMode = -997,
    kAseSpNotAdvancing = -996,
    kAseNoClock = -995,
    kAseNoMemory = -994
};

enum : AsioSampleType {
    kStInt16Lsb = 16,
    kStInt24Lsb = 17,
    kStInt32Lsb = 18,
    kStFloat32Lsb = 19,
    kStFloat64Lsb = 20,
    kStInt32Lsb16 = 24,
    kStInt32Lsb18 = 25,
    kStInt32Lsb20 = 26,
    kStInt32Lsb24 = 27,
    kStDsdInt8Lsb1 = 32,
    kStDsdInt8Msb1 = 33,
    kStDsdInt8Ner8 = 40
};

enum : long {
    kMsgSelectorSupported = 1,
    kMsgEngineVersion = 2,
    kMsgResetRequest = 3,
    kMsgBufferSizeChange = 4,
    kMsgResyncRequest = 5,
    kMsgLatenciesChanged = 6,
    kMsgSupportsTimeInfo = 7,
    kMsgSupportsTimeCode = 8
};

enum : long {
    kFutureSetIoFormat = 0x23111961L,
    kFutureGetIoFormat = 0x23111983L,
    kFutureCanDoIoFormat = 0x23112004L
};

enum : long {
    kIoFormatInvalid = -1,
    kIoFormatPcm = 0,
    kIoFormatDsd = 1
};

struct AsioIoFormat {
    long formatType = kIoFormatPcm;
    char future[512 - sizeof(long)] = {};
};

struct AsioClockSource {
    long index = 0;
    long associatedChannel = -1;
    long associatedGroup = -1;
    AsioBool isCurrentSource = 0;
    char name[32] = {};
};

struct AsioChannelInfo {
    long channel = 0;
    AsioBool isInput = 0;
    AsioBool isActive = 0;
    long channelGroup = 0;
    AsioSampleType type = kStInt32Lsb;
    char name[32] = {};
};

struct AsioBufferInfo {
    AsioBool isInput = 0;
    long channelNum = 0;
    void* buffers[2] = {nullptr, nullptr};
};

struct AsioTimeInfo {
    double speed = 1.0;
    AsioSamples64 systemTime{};
    AsioSamples64 samplePosition{};
    AsioSampleRate sampleRate = 48000.0;
    unsigned long flags = 0;
    char reserved[12] = {};
};

struct AsioTimeCode {
    double speed = 1.0;
    AsioSamples64 timeCodeSamples{};
    unsigned long flags = 0;
    char future[64] = {};
};

struct AsioTime {
    long reserved[4] = {};
    AsioTimeInfo timeInfo{};
    AsioTimeCode timeCode{};
};

struct AsioCallbacks {
    void (*bufferSwitch)(long doubleBufferIndex, AsioBool directProcess) = nullptr;
    void (*sampleRateDidChange)(AsioSampleRate sRate) = nullptr;
    long (*asioMessage)(long selector, long value, void* message, double* opt) = nullptr;
    AsioTime* (*bufferSwitchTimeInfo)(AsioTime* params, long doubleBufferIndex, AsioBool directProcess) = nullptr;
};

#pragma pack(pop)

// Clean-room COM vtable matching standard Windows x64 IASIO binary interface slots 3..23
struct IVantaAsioDriver : public IUnknown {
    virtual AsioBool init(void* sysHandle) = 0;
    virtual void getDriverName(char* name) = 0;
    virtual long getDriverVersion() = 0;
    virtual void getErrorMessage(char* str) = 0;
    virtual AsioError start() = 0;
    virtual AsioError stop() = 0;
    virtual AsioError getChannels(long* numInputChannels, long* numOutputChannels) = 0;
    virtual AsioError getLatencies(long* inputLatency, long* outputLatency) = 0;
    virtual AsioError getBufferSize(long* minSize, long* maxSize, long* preferredSize, long* granularity) = 0;
    virtual AsioError canSampleRate(AsioSampleRate sampleRate) = 0;
    virtual AsioError getSampleRate(AsioSampleRate* sampleRate) = 0;
    virtual AsioError setSampleRate(AsioSampleRate sampleRate) = 0;
    virtual AsioError getClockSources(AsioClockSource* clocks, long* numSources) = 0;
    virtual AsioError setClockSource(long reference) = 0;
    virtual AsioError getSamplePosition(AsioSamples64* sPos, AsioSamples64* tStamp) = 0;
    virtual AsioError getChannelInfo(AsioChannelInfo* info) = 0;
    virtual AsioError createBuffers(AsioBufferInfo* bufferInfos, long numChannels, long bufferSize, AsioCallbacks* callbacks) = 0;
    virtual AsioError disposeBuffers() = 0;
    virtual AsioError controlPanel() = 0;
    virtual AsioError future(long selector, void* opt) = 0;
    virtual AsioError outputReady() = 0;
};

struct AsioDriverRecord {
    std::string name;
    std::string clsid;
    std::string description;
};

inline std::string WideToUtf8Asio(const std::wstring& w) {
    if (w.empty()) return "";
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return "";
    std::string out(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, out.data(), n, nullptr, nullptr);
    return out;
}

inline std::wstring Utf8ToWideAsio(const std::string& s) {
    if (s.empty()) return L"";
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    if (n <= 1) return L"";
    std::wstring out(static_cast<size_t>(n - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
    return out;
}

inline std::vector<AsioDriverRecord> EnumerateAsioDrivers() {
    std::vector<AsioDriverRecord> drivers;
    HKEY hAsioRoot = nullptr;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO", 0, KEY_READ | KEY_WOW64_64KEY, &hAsioRoot) != ERROR_SUCCESS) {
        return drivers;
    }

    WCHAR subName[256] = {};
    for (DWORD idx = 0;; ++idx) {
        DWORD subLen = static_cast<DWORD>(sizeof(subName) / sizeof(subName[0]));
        const LONG enumRes = RegEnumKeyExW(hAsioRoot, idx, subName, &subLen, nullptr, nullptr, nullptr, nullptr);
        if (enumRes == ERROR_NO_MORE_ITEMS) break;
        if (enumRes != ERROR_SUCCESS) continue;

        HKEY hSub = nullptr;
        if (RegOpenKeyExW(hAsioRoot, subName, 0, KEY_READ | KEY_WOW64_64KEY, &hSub) != ERROR_SUCCESS) {
            continue;
        }

        auto readRegStr = [&](const wchar_t* valName) -> std::string {
            WCHAR buf[256] = {};
            DWORD cb = sizeof(buf);
            DWORD type = 0;
            if (RegQueryValueExW(hSub, valName, nullptr, &type, reinterpret_cast<LPBYTE>(buf), &cb) == ERROR_SUCCESS &&
                (type == REG_SZ || type == REG_EXPAND_SZ)) {
                buf[(sizeof(buf) / sizeof(buf[0])) - 1] = L'\0';
                return WideToUtf8Asio(buf);
            }
            return "";
        };

        AsioDriverRecord rec;
        rec.name = WideToUtf8Asio(subName);
        rec.clsid = readRegStr(L"CLSID");
        rec.description = readRegStr(L"Description");
        if (rec.description.empty()) rec.description = rec.name;
        RegCloseKey(hSub);

        if (!rec.clsid.empty()) {
            drivers.push_back(std::move(rec));
        }
    }

    RegCloseKey(hAsioRoot);
    return drivers;
}

struct AsioOpenConfig {
    std::string driverName;
    uint32_t sampleRate = 48000;
    uint16_t channels = 2;
    bool rawDsd = false;
    bool dsdLsbInput = false;
    uint32_t preferredBufferFrames = 0;
};

struct AsioSessionOutcome {
    bool ok = false;
    bool rawDsdActive = false;
    bool dsdMsbFirst = true;
    AsioSampleType sampleType = kStInt32Lsb;
    uint32_t sampleRate = 48000;
    uint16_t channels = 2;
    uint32_t bufferFrames = 0;
    std::string driverName;
    std::string errorMessage;
};

class AsioDriverHost final {
public:
    AsioDriverHost() = default;
    ~AsioDriverHost() {
        Close();
    }

    AsioDriverHost(const AsioDriverHost&) = delete;
    AsioDriverHost& operator=(const AsioDriverHost&) = delete;

    static void FillRawDsdSilence(void* dst, size_t byteCount) {
        if (dst && byteCount > 0) {
            std::memset(dst, 0x69, byteCount); // 01101001b zero-DC DSD idle pattern
        }
    }

    AsioSessionOutcome Open(const AsioOpenConfig& cfg) {
        Close();
        AsioSessionOutcome out{};

        const std::vector<AsioDriverRecord> drivers = EnumerateAsioDrivers();
        if (drivers.empty()) {
            out.errorMessage = "No ASIO drivers found in HKLM\\SOFTWARE\\ASIO";
            return out;
        }

        const AsioDriverRecord* matched = nullptr;
        if (!cfg.driverName.empty()) {
            for (const auto& d : drivers) {
                if (_stricmp(d.name.c_str(), cfg.driverName.c_str()) == 0 ||
                    _stricmp(d.description.c_str(), cfg.driverName.c_str()) == 0) {
                    matched = &d;
                    break;
                }
            }
        }
        if (!matched) {
            if (!cfg.driverName.empty()) {
                out.errorMessage = "Requested ASIO driver not registered: " + cfg.driverName;
                return out;
            }
            matched = &drivers.front();
        }

        const std::wstring clsidW = Utf8ToWideAsio(matched->clsid);
        CLSID clsid{};
        if (FAILED(CLSIDFromString(clsidW.c_str(), &clsid))) {
            out.errorMessage = "Invalid ASIO driver CLSID: " + matched->clsid;
            return out;
        }

        const HRESULT comHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (comHr == RPC_E_CHANGED_MODE) {
            // Thread already initialized as MTA; CoCreateInstance can still succeed depending on marshaling
            m_comOwned = false;
        } else if (SUCCEEDED(comHr)) {
            m_comOwned = true;
        } else {
            out.errorMessage = "CoInitializeEx(STA) failed for ASIO";
            return out;
        }

        IVantaAsioDriver* drv = nullptr;
        const HRESULT createHr = CoCreateInstance(clsid, nullptr, CLSCTX_INPROC_SERVER, clsid, reinterpret_cast<void**>(&drv));
        if (FAILED(createHr) || !drv) {
            out.errorMessage = "CoCreateInstance failed for ASIO driver " + matched->name;
            Close();
            return out;
        }
        m_driver = drv;

        if (!m_driver->init(GetConsoleWindow())) {
            char errBuf[256] = {};
            m_driver->getErrorMessage(errBuf);
            out.errorMessage = std::string("ASIO driver init() failed: ") + (errBuf[0] ? errBuf : matched->name);
            Close();
            return out;
        }

        char drvNameBuf[64] = {};
        m_driver->getDriverName(drvNameBuf);
        out.driverName = drvNameBuf[0] ? std::string(drvNameBuf) : matched->description;

        if (cfg.rawDsd) {
            AsioIoFormat dsdFmt{};
            dsdFmt.formatType = kIoFormatDsd;
            if (m_driver->future(kFutureCanDoIoFormat, &dsdFmt) != kAseSuccess ||
                m_driver->future(kFutureSetIoFormat, &dsdFmt) != kAseSuccess) {
                out.errorMessage = "ASIO driver rejected Native DSD I/O format";
                Close();
                return out;
            }
            out.rawDsdActive = true;
        } else {
            AsioIoFormat pcmFmt{};
            pcmFmt.formatType = kIoFormatPcm;
            m_driver->future(kFutureSetIoFormat, &pcmFmt); // Best effort reset back to PCM
        }

        const double reqRate = static_cast<double>(cfg.sampleRate);
        if (m_driver->canSampleRate(reqRate) != kAseOk) {
            out.errorMessage = "ASIO driver does not support sample rate " + std::to_string(cfg.sampleRate) + " Hz";
            Close();
            return out;
        }
        if (m_driver->setSampleRate(reqRate) != kAseOk) {
            out.errorMessage = "ASIO setSampleRate failed for " + std::to_string(cfg.sampleRate) + " Hz";
            Close();
            return out;
        }

        long numIn = 0;
        long numOut = 0;
        if (m_driver->getChannels(&numIn, &numOut) != kAseOk || numOut < static_cast<long>(cfg.channels)) {
            out.errorMessage = "ASIO insufficient output channels";
            Close();
            return out;
        }

        AsioChannelInfo ch0{};
        ch0.channel = 0;
        ch0.isInput = 0;
        if (m_driver->getChannelInfo(&ch0) != kAseOk) {
            out.errorMessage = "ASIO getChannelInfo failed";
            Close();
            return out;
        }

        if (cfg.rawDsd) {
            if (ch0.type != kStDsdInt8Lsb1 && ch0.type != kStDsdInt8Msb1 && ch0.type != kStDsdInt8Ner8) {
                out.errorMessage = "ASIO channel did not enter DSD int8 sample type";
                Close();
                return out;
            }
            out.dsdMsbFirst = (ch0.type == kStDsdInt8Msb1);
        }

        long minSz = 0, maxSz = 0, prefSz = 0, gran = 0;
        if (m_driver->getBufferSize(&minSz, &maxSz, &prefSz, &gran) != kAseOk || prefSz <= 0) {
            out.errorMessage = "ASIO getBufferSize failed";
            Close();
            return out;
        }

        long chosenBuf = prefSz;
        if (cfg.preferredBufferFrames > 0) {
            long req = static_cast<long>(cfg.preferredBufferFrames);
            if (req < minSz) req = minSz;
            if (maxSz > 0 && req > maxSz) req = maxSz;
            chosenBuf = req;
        }

        m_channels = cfg.channels;
        m_bufferFrames = static_cast<uint32_t>(chosenBuf);
        m_sampleType = ch0.type;
        m_rawDsd = cfg.rawDsd;
        m_supportsOutputReady = (m_driver->outputReady() == kAseOk);

        m_needFillEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        m_filledEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!m_needFillEvent || !m_filledEvent) {
            out.errorMessage = "Failed creating ASIO sync events";
            Close();
            return out;
        }

        m_bufInfos.assign(m_channels, AsioBufferInfo{});
        for (uint16_t ch = 0; ch < m_channels; ++ch) {
            m_bufInfos[ch].isInput = 0;
            m_bufInfos[ch].channelNum = static_cast<long>(ch);
            m_bufInfos[ch].buffers[0] = nullptr;
            m_bufInfos[ch].buffers[1] = nullptr;
        }

        m_callbacks.bufferSwitch = &StaticBufferSwitch;
        m_callbacks.sampleRateDidChange = &StaticSampleRateChanged;
        m_callbacks.asioMessage = &StaticAsioMessage;
        m_callbacks.bufferSwitchTimeInfo = &StaticBufferSwitchTimeInfo;

        {
            std::lock_guard<std::mutex> lk(ActiveInstanceMutex());
            s_activeInstance = this;
        }

        const AsioError cbErr = m_driver->createBuffers(m_bufInfos.data(), static_cast<long>(m_channels), chosenBuf, &m_callbacks);
        if (cbErr != kAseOk) {
            out.errorMessage = "ASIO createBuffers failed";
            Close();
            return out;
        }
        m_buffersCreated = true;

        // Pre-clear both DMA double buffers cleanly
        const size_t chBytes = BytesPerChannelBuffer();
        for (uint16_t ch = 0; ch < m_channels; ++ch) {
            for (int b = 0; b < 2; ++b) {
                if (m_bufInfos[ch].buffers[b]) {
                    if (m_rawDsd) FillRawDsdSilence(m_bufInfos[ch].buffers[b], chBytes);
                    else std::memset(m_bufInfos[ch].buffers[b], 0, chBytes);
                }
            }
        }

        m_stopping.store(false);
        m_started = false;
        m_resetRequested.store(false);

        out.ok = true;
        out.sampleType = m_sampleType;
        out.sampleRate = cfg.sampleRate;
        out.channels = m_channels;
        out.bufferFrames = m_bufferFrames;
        return out;
    }

    size_t BytesPerChannelBuffer() const {
        if (m_rawDsd) {
            return static_cast<size_t>(m_bufferFrames) / 8u;
        }
        switch (m_sampleType) {
            case kStInt16Lsb: return static_cast<size_t>(m_bufferFrames) * 2u;
            case kStInt24Lsb: return static_cast<size_t>(m_bufferFrames) * 3u;
            case kStFloat64Lsb: return static_cast<size_t>(m_bufferFrames) * 8u;
            default: return static_cast<size_t>(m_bufferFrames) * 4u;
        }
    }

    bool Start() {
        if (!m_driver || !m_buffersCreated) return false;
        m_stopping.store(false);
        ResetEvent(m_needFillEvent);
        ResetEvent(m_filledEvent);
        if (m_driver->start() != kAseOk) {
            return false;
        }
        m_started = true;
        return true;
    }

    void Stop() {
        m_stopping.store(true);
        if (m_filledEvent) SetEvent(m_filledEvent);
        if (m_needFillEvent) SetEvent(m_needFillEvent);
        if (m_driver && m_started) {
            m_driver->stop();
            m_started = false;
        }
    }

    bool WaitNextSwitch(uint32_t timeoutMs, uint32_t& outUnitCount, bool& outTimedOut) {
        outTimedOut = false;
        if (!m_started || m_stopping.load() || m_resetRequested.load()) {
            outUnitCount = 0;
            return false;
        }
        const DWORD wr = WaitForSingleObject(m_needFillEvent, timeoutMs);
        if (m_stopping.load() || m_resetRequested.load()) {
            outUnitCount = 0;
            return false;
        }
        if (wr == WAIT_TIMEOUT) {
            outTimedOut = true;
            outUnitCount = 0;
            return true;
        }
        if (wr != WAIT_OBJECT_0) {
            outUnitCount = 0;
            return false;
        }
        outUnitCount = m_rawDsd ? (m_bufferFrames / 8u) : m_bufferFrames;
        return outUnitCount > 0;
    }

    void PublishChannelData(const std::vector<BYTE>& interleavedStaging, bool silent) {
        const long idx = m_activeIndex.load();
        if (idx < 0 || idx > 1 || !m_buffersCreated) {
            if (m_filledEvent) SetEvent(m_filledEvent);
            return;
        }
        const size_t chBytes = BytesPerChannelBuffer();
        if (silent) {
            for (uint16_t ch = 0; ch < m_channels; ++ch) {
                void* pDst = m_bufInfos[ch].buffers[idx];
                if (m_rawDsd) FillRawDsdSilence(pDst, chBytes);
                else if (pDst) std::memset(pDst, 0, chBytes);
            }
        } else if (m_rawDsd) {
            // Interleaved DSD octets -> planar ASIO channel octets
            const size_t byteFrames = m_bufferFrames / 8u;
            for (uint16_t ch = 0; ch < m_channels; ++ch) {
                BYTE* dst = static_cast<BYTE*>(m_bufInfos[ch].buffers[idx]);
                if (!dst) continue;
                for (size_t f = 0; f < byteFrames; ++f) {
                    const size_t srcOff = f * m_channels + ch;
                    dst[f] = (srcOff < interleavedStaging.size()) ? interleavedStaging[srcOff] : BYTE{0x69};
                }
            }
        } else {
            // Interleaved PCM -> planar ASIO channel DMA buffers
            for (uint16_t ch = 0; ch < m_channels; ++ch) {
                BYTE* dst = static_cast<BYTE*>(m_bufInfos[ch].buffers[idx]);
                if (!dst) continue;
                switch (m_sampleType) {
                    case kStInt16Lsb: {
                        const auto* sIn = reinterpret_cast<const int16_t*>(interleavedStaging.data());
                        auto* sOut = reinterpret_cast<int16_t*>(dst);
                        for (uint32_t f = 0; f < m_bufferFrames; ++f) {
                            sOut[f] = sIn[static_cast<size_t>(f) * m_channels + ch];
                        }
                        break;
                    }
                    case kStInt24Lsb: {
                        for (uint32_t f = 0; f < m_bufferFrames; ++f) {
                            const size_t srcOff = (static_cast<size_t>(f) * m_channels + ch) * 3u;
                            dst[f * 3u + 0] = interleavedStaging[srcOff + 0];
                            dst[f * 3u + 1] = interleavedStaging[srcOff + 1];
                            dst[f * 3u + 2] = interleavedStaging[srcOff + 2];
                        }
                        break;
                    }
                    case kStInt32Lsb24: {
                        const auto* iIn = reinterpret_cast<const int32_t*>(interleavedStaging.data());
                        auto* iOut = reinterpret_cast<int32_t*>(dst);
                        for (uint32_t f = 0; f < m_bufferFrames; ++f) {
                            iOut[f] = iIn[static_cast<size_t>(f) * m_channels + ch] >> 8;
                        }
                        break;
                    }
                    case kStFloat64Lsb: {
                        const auto* dIn = reinterpret_cast<const double*>(interleavedStaging.data());
                        auto* dOut = reinterpret_cast<double*>(dst);
                        for (uint32_t f = 0; f < m_bufferFrames; ++f) {
                            dOut[f] = dIn[static_cast<size_t>(f) * m_channels + ch];
                        }
                        break;
                    }
                    default: {
                        // kStInt32Lsb or kStFloat32Lsb (both 32-bit/sample planar copy)
                        const auto* uIn = reinterpret_cast<const uint32_t*>(interleavedStaging.data());
                        auto* uOut = reinterpret_cast<uint32_t*>(dst);
                        for (uint32_t f = 0; f < m_bufferFrames; ++f) {
                            uOut[f] = uIn[static_cast<size_t>(f) * m_channels + ch];
                        }
                        break;
                    }
                }
            }
        }
        if (m_filledEvent) SetEvent(m_filledEvent);
        if (m_supportsOutputReady && m_driver) {
            m_driver->outputReady();
        }
    }

    void Close() {
        Stop();
        {
            std::lock_guard<std::mutex> lk(ActiveInstanceMutex());
            if (s_activeInstance == this) {
                s_activeInstance = nullptr;
            }
        }
        if (m_driver) {
            if (m_buffersCreated) {
                m_driver->disposeBuffers();
                m_buffersCreated = false;
            }
            m_driver->Release();
            m_driver = nullptr;
        }
        m_bufInfos.clear();
        if (m_needFillEvent) {
            CloseHandle(m_needFillEvent);
            m_needFillEvent = nullptr;
        }
        if (m_filledEvent) {
            CloseHandle(m_filledEvent);
            m_filledEvent = nullptr;
        }
        if (m_comOwned) {
            CoUninitialize();
            m_comOwned = false;
        }
    }

    bool WasResetRequested() const { return m_resetRequested.load(); }

private:
    static std::mutex& ActiveInstanceMutex() {
        static std::mutex m;
        return m;
    }

    static inline AsioDriverHost* s_activeInstance = nullptr;

    void HandleBufferSwitch(long idx) {
        if (m_stopping.load() || !m_buffersCreated) return;
        m_activeIndex.store(idx);
        if (m_needFillEvent) SetEvent(m_needFillEvent);
        if (m_filledEvent) {
            const DWORD wr = WaitForSingleObject(m_filledEvent, 45);
            if (wr != WAIT_OBJECT_0 || m_stopping.load()) {
                const size_t chBytes = BytesPerChannelBuffer();
                for (uint16_t ch = 0; ch < m_channels; ++ch) {
                    void* pDst = m_bufInfos[ch].buffers[idx];
                    if (m_rawDsd) FillRawDsdSilence(pDst, chBytes);
                    else if (pDst) std::memset(pDst, 0, chBytes);
                }
            }
        }
    }

    static void StaticBufferSwitch(long doubleBufferIndex, AsioBool /*directProcess*/) {
        AsioDriverHost* inst = s_activeInstance;
        if (inst) inst->HandleBufferSwitch(doubleBufferIndex);
    }

    static AsioTime* StaticBufferSwitchTimeInfo(AsioTime* params, long doubleBufferIndex, AsioBool directProcess) {
        StaticBufferSwitch(doubleBufferIndex, directProcess);
        return params;
    }

    static void StaticSampleRateChanged(AsioSampleRate /*sRate*/) {
        AsioDriverHost* inst = s_activeInstance;
        if (inst) inst->m_resetRequested.store(true);
    }

    static long StaticAsioMessage(long selector, long value, void* /*message*/, double* /*opt*/) {
        AsioDriverHost* inst = s_activeInstance;
        switch (selector) {
            case kMsgSelectorSupported:
                switch (value) {
                    case kMsgSelectorSupported:
                    case kMsgEngineVersion:
                    case kMsgResetRequest:
                    case kMsgResyncRequest:
                    case kMsgLatenciesChanged:
                    case kMsgSupportsTimeInfo:
                        return 1L;
                    default:
                        return 0L;
                }
            case kMsgEngineVersion:
                return 2L;
            case kMsgResetRequest:
            case kMsgResyncRequest:
                if (inst) inst->m_resetRequested.store(true);
                return 1L;
            case kMsgLatenciesChanged:
                return 1L;
            case kMsgSupportsTimeInfo:
                return 1L;
            default:
                return 0L;
        }
    }

    IVantaAsioDriver* m_driver = nullptr;
    bool m_comOwned = false;
    bool m_buffersCreated = false;
    bool m_started = false;
    bool m_rawDsd = false;
    bool m_supportsOutputReady = false;
    uint16_t m_channels = 2;
    uint32_t m_bufferFrames = 0;
    AsioSampleType m_sampleType = kStInt32Lsb;
    std::vector<AsioBufferInfo> m_bufInfos;
    AsioCallbacks m_callbacks{};
    HANDLE m_needFillEvent = nullptr;
    HANDLE m_filledEvent = nullptr;
    std::atomic<long> m_activeIndex{0};
    std::atomic<bool> m_stopping{false};
    std::atomic<bool> m_resetRequested{false};
};

} // namespace vanta_asio
