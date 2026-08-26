#import <AppKit/AppKit.h>
#import <AVFAudio/AVFAudio.h>
#import <MediaPlayer/MediaPlayer.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <complex>
#include <csignal>
#include <deque>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unistd.h>
#include <utility>
#include <vector>

#ifndef AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
#define AIDEN_AMBIENT_MUSIC_WITH_MAGENTA 0
#endif

#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
#include <magentart/realtime_runner.h>
#endif

constexpr NSInteger kProtocolVersion = 1;
constexpr char kBuildIdentity[] = "aiden-ambient-music-helper/1";
constexpr std::size_t kMaximumMessageBytes = 64 * 1024;
constexpr double kSampleRate = 48000.0;
constexpr AVAudioChannelCount kChannels = 2;
constexpr std::size_t kVisualizerBandCount = 18;
constexpr std::array<float, kVisualizerBandCount + 1> kVisualizerCutoffs = {
  50.0f, 80.0f, 120.0f, 180.0f, 260.0f, 380.0f, 550.0f,
  800.0f, 1150.0f, 1650.0f, 2350.0f, 3300.0f, 4500.0f,
  6000.0f, 7600.0f, 9500.0f, 11500.0f, 14000.0f, 17000.0f,
};

struct VariationUpdate {
  int seedRotation;
  bool triggerReset;
};

VariationUpdate variation_update(float variation) {
  return { (int)lroundf(variation * 1000.0f), true };
}

bool remote_command_allowed(bool loaded, bool promptReady, bool benchmarkMode, bool suspended) {
  return loaded && promptReady && !benchmarkMode && !suspended;
}

bool now_playing_allowed(bool loaded, bool promptReady, bool benchmarkMode,
                         bool stopped, bool suspended) {
  return loaded && promptReady && !benchmarkMode && !stopped && !suspended;
}

bool route_recovery_preserves_terminal_state(bool stopped, bool suspended) {
  return stopped || suspended;
}

std::mutex output_mutex;
std::atomic<std::uint64_t> event_sequence{0};
NSString *approved_model_root = nil;
FILE *protocol_output = nullptr;

BOOL isolate_protocol_output() {
  const int protocol_fd = dup(STDOUT_FILENO);
  if (protocol_fd < 0) return NO;
  if (dup2(STDERR_FILENO, STDOUT_FILENO) < 0) {
    close(protocol_fd);
    return NO;
  }
  protocol_output = fdopen(protocol_fd, "w");
  if (!protocol_output) {
    close(protocol_fd);
    return NO;
  }
  setvbuf(protocol_output, nullptr, _IOLBF, 0);
  return YES;
}

void write_json(NSDictionary *payload) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
  if (error || !data) return;
  std::lock_guard<std::mutex> lock(output_mutex);
  FILE *stream = protocol_output ?: stdout;
  fwrite(data.bytes, 1, data.length, stream);
  fputc('\n', stream);
  fflush(stream);
}

NSDictionary *event(NSString *name, NSDictionary *detail = @{}) {
  return @{
    @"version": @(kProtocolVersion),
    @"type": @"event",
    @"event": name,
    @"sequence": @(event_sequence.fetch_add(1, std::memory_order_relaxed) + 1),
    @"detail": detail,
  };
}

NSDictionary *response(NSString *request_id, BOOL ok, NSDictionary *result = @{},
                       NSString *code = nil, NSString *message = nil) {
  NSMutableDictionary *payload = [@{
    @"version": @(kProtocolVersion),
    @"type": @"response",
    @"requestId": request_id ?: @"",
    @"ok": @(ok),
  } mutableCopy];
  if (ok) {
    payload[@"result"] = result;
  } else {
    payload[@"error"] = @{
      @"code": code ?: @"internal_failure",
      @"message": message ?: @"The Ambient Music helper could not complete the request.",
    };
  }
  return payload;
}

BOOL is_safe_identifier(NSString *value, NSUInteger maximum_length = 64) {
  if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > maximum_length) {
    return NO;
  }
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-."] invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

BOOL is_json_boolean(id value) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

BOOL is_json_integer(id value) {
  if (![value isKindOfClass:NSNumber.class] || is_json_boolean(value)) return NO;
  const double number = [value doubleValue];
  return std::isfinite(number) && std::floor(number) == number;
}

BOOL contains_forbidden_prompt_character(NSString *value) {
  static NSCharacterSet *forbidden;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSMutableCharacterSet *characters = [NSCharacterSet.controlCharacterSet mutableCopy];
    [characters addCharactersInRange:NSMakeRange(0x7f, 1)];
    forbidden = [characters copy];
  });
  return [value rangeOfCharacterFromSet:forbidden].location != NSNotFound;
}

NSString *prompt_mix_summary(NSArray<NSString *> *prompts) {
  if (prompts.count == 0) return @"On-device mix";
  NSString *first = [prompts.firstObject
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  static const NSUInteger kMaximumSummaryCharacters = 96;
  if (first.length > kMaximumSummaryCharacters) {
    NSRange range = [first rangeOfComposedCharacterSequencesForRange:
        NSMakeRange(0, kMaximumSummaryCharacters - 1)];
    first = [[first substringWithRange:range] stringByAppendingString:@"…"];
  }
  if (prompts.count == 1) return first.length ? first : @"On-device mix";
  return [NSString stringWithFormat:@"%@ +%lu", first.length ? first : @"On-device mix",
                                    (unsigned long)(prompts.count - 1)];
}

NSDictionary *now_playing_metadata(NSString *promptSummary, BOOL playing, MPMediaItemArtwork *artwork) {
  NSMutableDictionary *metadata = [@{
    MPMediaItemPropertyTitle: @"Ambient Music",
    MPMediaItemPropertyArtist: @"Aiden · Generated on this Mac",
    MPMediaItemPropertyAlbumTitle: promptSummary.length ? promptSummary : @"On-device mix",
    MPNowPlayingInfoPropertyPlaybackRate: playing ? @1.0 : @0.0,
    MPNowPlayingInfoPropertyIsLiveStream: @YES,
    MPNowPlayingInfoPropertyMediaType: @(MPNowPlayingInfoMediaTypeAudio),
  } mutableCopy];
  if (artwork) metadata[MPMediaItemPropertyArtwork] = artwork;
  return metadata;
}

NSString *playback_state(BOOL loaded, BOOL playing, BOOL stopped) {
  return !loaded || stopped ? @"stopped" : (playing ? @"playing" : @"paused");
}

NSString *canonical_existing_path(NSString *path) {
  char resolved[PATH_MAX];
  if (!path || !realpath(path.fileSystemRepresentation, resolved)) return nil;
  return [NSString stringWithUTF8String:resolved];
}

BOOL is_contained_path(NSString *candidate, NSString *root) {
  NSString *prefix = [root stringByAppendingString:@"/"];
  return [candidate hasPrefix:prefix];
}

struct RenderState {
  std::atomic<bool> loaded{false};
  std::atomic<bool> selfTestTone{false};
  std::atomic<float> outputGain{0.0f};
  std::atomic<float> targetGain{0.0f};
  std::atomic<bool> forceSilent{false};
  std::atomic<double> phase{0.0};
  std::array<float, kVisualizerBandCount + 1> visualizerLeftLowpass{};
  std::array<float, kVisualizerBandCount + 1> visualizerRightLowpass{};
  std::array<std::atomic<float>, kVisualizerBandCount> visualizerBands{};
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  magentart::core::RealtimeRunner *runner = nullptr;
#endif
};

struct VisualizerFilterConfiguration {
  std::array<float, kVisualizerBandCount + 1> coefficients{};
  std::array<float, kVisualizerBandCount> responseScale{};
};

const VisualizerFilterConfiguration& visualizer_filter_configuration() {
  static const VisualizerFilterConfiguration configuration = [] {
    VisualizerFilterConfiguration value{};
    for (std::size_t index = 0; index < value.coefficients.size(); ++index) {
      value.coefficients[index] =
          1.0f - std::exp(-2.0f * static_cast<float>(M_PI) *
                          kVisualizerCutoffs[index] / static_cast<float>(kSampleRate));
    }
    for (std::size_t band = 0; band < value.responseScale.size(); ++band) {
      const float center = std::sqrt(kVisualizerCutoffs[band] * kVisualizerCutoffs[band + 1]);
      const float omega = 2.0f * static_cast<float>(M_PI) * center /
                          static_cast<float>(kSampleRate);
      const std::complex<float> delay(std::cos(omega), -std::sin(omega));
      const auto response = [&](float alpha) {
        return alpha / (1.0f - (1.0f - alpha) * delay);
      };
      const float centerMagnitude = std::abs(
          response(value.coefficients[band + 1]) - response(value.coefficients[band]));
      value.responseScale[band] = 1.0f / std::max(centerMagnitude, 0.000001f);
    }
    return value;
  }();
  return configuration;
}

float normalized_visualizer_level(float rms) {
  if (!std::isfinite(rms) || rms <= 0.000001f) return 0.0f;
  const float decibels = 20.0f * std::log10(rms);
  return std::clamp((decibels + 72.0f) / 60.0f, 0.0f, 1.0f);
}

void update_visualizer_bands(RenderState *state, const float *left, const float *right,
                             AVAudioFrameCount frameCount, bool audible) {
  if (!audible || frameCount == 0) {
    state->visualizerLeftLowpass.fill(0.0f);
    state->visualizerRightLowpass.fill(0.0f);
    for (auto& band : state->visualizerBands) {
      band.store(band.load(std::memory_order_relaxed) * 0.58f, std::memory_order_relaxed);
    }
    return;
  }

  // A fixed one-pole filter bank stays allocation- and lock-free on the audio
  // render thread. Only 18 normalized scalar energies cross the JSONL boundary.
  std::array<double, kVisualizerBandCount> energy{};
  const auto& configuration = visualizer_filter_configuration();
  for (AVAudioFrameCount frame = 0; frame < frameCount; ++frame) {
    for (std::size_t cutoff = 0; cutoff < state->visualizerLeftLowpass.size(); ++cutoff) {
      float& leftLowpass = state->visualizerLeftLowpass[cutoff];
      float& rightLowpass = state->visualizerRightLowpass[cutoff];
      const float coefficient = configuration.coefficients[cutoff];
      leftLowpass += coefficient * (left[frame] - leftLowpass);
      rightLowpass += coefficient * (right[frame] - rightLowpass);
    }
    for (std::size_t band = 0; band < energy.size(); ++band) {
      const float scale = configuration.responseScale[band];
      const float leftValue =
          (state->visualizerLeftLowpass[band + 1] - state->visualizerLeftLowpass[band]) * scale;
      const float rightValue =
          (state->visualizerRightLowpass[band + 1] - state->visualizerRightLowpass[band]) * scale;
      energy[band] += 0.5 * (
          static_cast<double>(leftValue) * static_cast<double>(leftValue) +
          static_cast<double>(rightValue) * static_cast<double>(rightValue));
    }
  }

  for (std::size_t index = 0; index < energy.size(); ++index) {
    const float rms = static_cast<float>(std::sqrt(energy[index] / frameCount));
    const float measured = normalized_visualizer_level(rms);
    auto& band = state->visualizerBands[index];
    const float previous = band.load(std::memory_order_relaxed);
    const float smoothing = measured > previous ? 0.56f : 0.18f;
    band.store(previous + (measured - previous) * smoothing, std::memory_order_relaxed);
  }
}

struct VisualizerProbe {
  std::size_t dominantBand;
  float peakLevel;
};

VisualizerProbe probe_visualizer_tone(float frequency, bool antiPhase = false) {
  RenderState state;
  for (auto& band : state.visualizerBands) band.store(0.0f, std::memory_order_relaxed);
  constexpr std::size_t kProbeFrames = 256;
  constexpr std::size_t kProbeCallbacks = 188;
  std::array<float, kProbeFrames> left{};
  std::array<float, kProbeFrames> right{};
  double phase = 0.0;
  const double phaseStep = 2.0 * M_PI * frequency / kSampleRate;
  for (std::size_t callback = 0; callback < kProbeCallbacks; ++callback) {
    for (std::size_t frame = 0; frame < kProbeFrames; ++frame) {
      const float sample = static_cast<float>(std::sin(phase) * 0.01);
      left[frame] = sample;
      right[frame] = antiPhase ? -sample : sample;
      phase += phaseStep;
      if (phase >= 2.0 * M_PI) phase -= 2.0 * M_PI;
    }
    update_visualizer_bands(&state, left.data(), right.data(), kProbeFrames, true);
  }
  VisualizerProbe result{0, 0.0f};
  for (std::size_t band = 0; band < state.visualizerBands.size(); ++band) {
    const float level = state.visualizerBands[band].load(std::memory_order_relaxed);
    if (level > result.peakLevel) result = {band, level};
  }
  return result;
}

bool visualizer_filter_bank_contracts_verified() {
  const std::array<std::pair<float, std::size_t>, 5> probes = {{
    {100.0f, 1}, {1000.0f, 7}, {5200.0f, 12}, {10500.0f, 15}, {15000.0f, 17},
  }};
  for (const auto& [frequency, expectedBand] : probes) {
    const VisualizerProbe probe = probe_visualizer_tone(frequency);
    const std::size_t distance = probe.dominantBand > expectedBand
        ? probe.dominantBand - expectedBand : expectedBand - probe.dominantBand;
    if (distance > 1 || probe.peakLevel <= 0.1f || probe.peakLevel > 1.0f) return false;
  }
  const VisualizerProbe antiPhase = probe_visualizer_tone(1000.0f, true);
  if (antiPhase.peakLevel <= 0.1f || antiPhase.dominantBand < 6 || antiPhase.dominantBand > 8) {
    return false;
  }

  RenderState decayState;
  for (auto& band : decayState.visualizerBands) band.store(0.5f, std::memory_order_relaxed);
  std::array<float, 256> silence{};
  for (int callback = 0; callback < 16; ++callback) {
    update_visualizer_bands(&decayState, silence.data(), silence.data(), silence.size(), false);
  }
  for (const auto& band : decayState.visualizerBands) {
    const float level = band.load(std::memory_order_relaxed);
    if (!std::isfinite(level) || level < 0.0f || level >= 0.001f) return false;
  }

  RenderState budgetState;
  for (auto& band : budgetState.visualizerBands) band.store(0.0f, std::memory_order_relaxed);
  std::array<float, 256> signal{};
  for (std::size_t frame = 0; frame < signal.size(); ++frame) {
    signal[frame] = static_cast<float>(std::sin(2.0 * M_PI * 1000.0 * frame / kSampleRate) * 0.01);
  }
  constexpr int kBudgetCallbacks = 200;
  const auto started = std::chrono::steady_clock::now();
  for (int callback = 0; callback < kBudgetCallbacks; ++callback) {
    update_visualizer_bands(&budgetState, signal.data(), signal.data(), signal.size(), true);
  }
  const auto elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started);
  const double renderedDuration = kBudgetCallbacks * signal.size() / kSampleRate;
  return elapsed.count() < renderedDuration * 0.75;
}

@interface AmbientAudioController : NSObject
@property(nonatomic, readonly) BOOL loaded;
@property(nonatomic, readonly) BOOL playing;
@property(nonatomic, readonly) NSString *modelName;
- (BOOL)startAudio:(NSError **)error;
- (void)loadModelRoot:(NSString *)root modelName:(NSString *)modelName completion:(void (^)(BOOL, NSString *))completion;
- (void)setPrompts:(NSArray<NSString *> *)prompts weights:(NSArray<NSNumber *> *)weights completion:(void (^)(BOOL, NSString *))completion;
- (void)setWeights:(NSArray<NSNumber *> *)weights;
- (void)setVolumeDB:(float)volumeDB;
- (void)setDrumless:(BOOL)drumless;
- (void)setVariation:(float)variation;
- (void)setBenchmarkMode:(BOOL)enabled;
- (void)play;
- (void)pause;
- (void)suspendForSystemSleep;
- (void)resumeFromSystemSleep;
- (void)stop;
- (void)reset;
- (void)unloadWithCompletion:(void (^)(void))completion;
- (NSDictionary *)metrics;
- (void)prepareForTermination;
- (void)prepareForTerminationWithCompletion:(void (^)(void))completion;
- (NSDictionary *)playbackResult;
@end

@implementation AmbientAudioController {
  AVAudioEngine *_audioEngine;
  AVAudioSourceNode *_sourceNode;
  std::unique_ptr<RenderState> _renderState;
  std::atomic<bool> _playing;
  std::atomic<bool> _loading;
  std::atomic<bool> _promptReady;
  std::atomic<bool> _stopped;
  std::atomic<bool> _systemSuspended;
  std::atomic<std::uint64_t> _suspendGeneration;
  std::atomic<std::uint64_t> _lifecycleGeneration;
  std::atomic<std::uint64_t> _playbackRevision;
  dispatch_queue_t _lifecycleQueue;
  NSString *_modelName;
  NSString *_promptSummary;
  MPMediaItemArtwork *_artwork;
  id _audioConfigurationObserver;
  BOOL _rebuildingAudio;
  BOOL _benchmarkMode;
  BOOL _terminating;
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  magentart::core::RealtimeRunner _runner;
#endif
}

- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  _renderState = std::make_unique<RenderState>();
  (void)visualizer_filter_configuration();
  for (auto& band : _renderState->visualizerBands) {
    band.store(0.0f, std::memory_order_relaxed);
  }
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _renderState->runner = &_runner;
#endif
  _playing.store(false);
  _loading.store(false);
  _promptReady.store(false);
  _stopped.store(true);
  _systemSuspended.store(false);
  _suspendGeneration.store(0);
  _lifecycleGeneration.store(0);
  _playbackRevision.store(0);
  _lifecycleQueue = dispatch_queue_create("com.sambitcreate.aiden-agent.ambient-music.lifecycle", DISPATCH_QUEUE_SERIAL);
  _modelName = @"";
  _promptSummary = @"On-device mix";
  NSString *artworkPath = [NSBundle.mainBundle pathForResource:@"AmbientMusicArtwork" ofType:@"png"];
  NSImage *artworkImage = artworkPath ? [[NSImage alloc] initWithContentsOfFile:artworkPath] : nil;
  if (artworkImage) {
    _artwork = [[MPMediaItemArtwork alloc] initWithBoundsSize:artworkImage.size
        requestHandler:^NSImage *(CGSize) { return artworkImage; }];
  }
  _terminating = NO;
  [self configureRemoteCommands];
  [self clearNowPlaying];
  return self;
}

- (BOOL)loaded { return _renderState->loaded.load(std::memory_order_acquire); }
- (BOOL)playing { return _playing.load(std::memory_order_acquire); }
- (NSString *)modelName { return _modelName; }

- (BOOL)startAudio:(NSError **)error {
  if (_audioEngine && _audioEngine.isRunning) return YES;
  _audioEngine = [[AVAudioEngine alloc] init];
  AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:kSampleRate channels:kChannels];
  RenderState *renderState = _renderState.get();
  _sourceNode = [[AVAudioSourceNode alloc] initWithFormat:format
      renderBlock:^OSStatus(BOOL *isSilence, const AudioTimeStamp *, AVAudioFrameCount frameCount,
                            AudioBufferList *outputData) {
    float *left = static_cast<float *>(outputData->mBuffers[0].mData);
    float *right = outputData->mNumberBuffers > 1
        ? static_cast<float *>(outputData->mBuffers[1].mData) : left;
    BOOL produced = NO;
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
    if (renderState->loaded.load(std::memory_order_acquire)) {
      renderState->runner->read_audio_stereo(left, right, frameCount, false);
      produced = YES;
    }
#endif
    if (!produced && renderState->selfTestTone.load(std::memory_order_relaxed)) {
      double phase = renderState->phase.load(std::memory_order_relaxed);
      for (AVAudioFrameCount index = 0; index < frameCount; ++index) {
        const float sample = static_cast<float>(std::sin(phase) * 0.01);
        left[index] = sample;
        right[index] = sample;
        phase += 2.0 * M_PI * 220.0 / kSampleRate;
        if (phase >= 2.0 * M_PI) phase -= 2.0 * M_PI;
      }
      renderState->phase.store(phase, std::memory_order_relaxed);
      produced = YES;
    }
    if (!produced) {
      memset(left, 0, frameCount * sizeof(float));
      if (right != left) memset(right, 0, frameCount * sizeof(float));
    }

    float gain = renderState->outputGain.load(std::memory_order_relaxed);
    const float target = renderState->targetGain.load(std::memory_order_relaxed);
    const float alpha = 1.0f - std::exp(-1.0f / (0.02f * 48000.0f));
    for (AVAudioFrameCount index = 0; index < frameCount; ++index) {
      gain += (target - gain) * alpha;
      left[index] = std::tanh(left[index] * gain);
      right[index] = std::tanh(right[index] * gain);
    }
    renderState->outputGain.store(gain, std::memory_order_relaxed);
    const bool forceSilent = renderState->forceSilent.load(std::memory_order_relaxed);
    update_visualizer_bands(renderState, left, right, frameCount,
                            produced && gain >= 0.0001f);
    if (forceSilent) {
      memset(left, 0, frameCount * sizeof(float));
      if (right != left) memset(right, 0, frameCount * sizeof(float));
      *isSilence = YES;
    } else {
      *isSilence = !produced || gain < 0.0001f;
    }
    return noErr;
  }];
  [_audioEngine attachNode:_sourceNode];
  [_audioEngine connect:_sourceNode to:_audioEngine.mainMixerNode format:format];
  const BOOL started = [_audioEngine startAndReturnError:error];
  if (started) {
    if (_audioConfigurationObserver) {
      [NSNotificationCenter.defaultCenter removeObserver:_audioConfigurationObserver];
      _audioConfigurationObserver = nil;
    }
    __weak AmbientAudioController *weakSelf = self;
    _audioConfigurationObserver = [NSNotificationCenter.defaultCenter
        addObserverForName:AVAudioEngineConfigurationChangeNotification
                    object:_audioEngine
                     queue:NSOperationQueue.mainQueue
                usingBlock:^(NSNotification *) {
      AmbientAudioController *strongSelf = weakSelf;
      if (!strongSelf || strongSelf->_rebuildingAudio) return;
      strongSelf->_rebuildingAudio = YES;
      const BOOL wasStopped = strongSelf->_stopped.load(std::memory_order_acquire);
      const BOOL wasSuspended = strongSelf->_systemSuspended.load(std::memory_order_acquire);
      if (route_recovery_preserves_terminal_state(wasStopped, wasSuspended)) {
        strongSelf->_playing.store(false, std::memory_order_release);
        strongSelf->_playbackRevision.fetch_add(1);
        strongSelf->_renderState->targetGain.store(0.0f);
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
        strongSelf->_runner.set_bypass(true);
#endif
      } else {
        [strongSelf pause];
      }
      [strongSelf->_audioEngine stop];
      strongSelf->_audioEngine = nil;
      strongSelf->_sourceNode = nil;
      NSError *restartError = nil;
      const BOOL recovered = [strongSelf startAudio:&restartError];
      strongSelf->_rebuildingAudio = NO;
      if (route_recovery_preserves_terminal_state(wasStopped, wasSuspended)) {
        strongSelf->_stopped.store(wasStopped, std::memory_order_release);
        [strongSelf clearNowPlaying];
      }
      write_json(event(@"audioState", @{
        @"state": recovered ? @"recovered" : @"failed",
        @"message": recovered ? @"" : (restartError.localizedDescription ?: @"Audio output could not be restored."),
        @"playback": [strongSelf playbackResult],
      }));
    }];
  }
  return started;
}

- (void)loadModelRoot:(NSString *)root modelName:(NSString *)modelName completion:(void (^)(BOOL, NSString *))completion {
  if (![modelName isEqualToString:@"mrt2_small"] && ![modelName isEqualToString:@"mrt2_base"]) {
    completion(NO, @"Unsupported model identifier.");
    return;
  }
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  if (_loading.exchange(true)) {
    completion(NO, @"A model operation is already in progress.");
    return;
  }
  [self pause];
  _promptReady.store(false);
  _promptSummary = @"On-device mix";
  _renderState->loaded.store(false, std::memory_order_release);
  const std::uint64_t generation = _lifecycleGeneration.fetch_add(1) + 1;
  NSString *resources = [root stringByAppendingPathComponent:@"resources"];
  NSString *modelDirectory = [[root stringByAppendingPathComponent:@"models"] stringByAppendingPathComponent:modelName];
  NSString *model = [modelDirectory stringByAppendingPathComponent:[modelName stringByAppendingString:@".mlxfn"]];
  NSString *canonicalResources = canonical_existing_path(resources);
  NSString *canonicalModel = canonical_existing_path(model);
  if (!canonicalResources || !canonicalModel || !is_contained_path(canonicalResources, root) || !is_contained_path(canonicalModel, root)) {
    _loading.store(false);
    completion(NO, @"The verified model install contains an invalid or escaped path.");
    return;
  }
  dispatch_async(_lifecycleQueue, ^{
    self->_runner.unload();
    BOOL assetsLoaded = self->_runner.init_assets(canonicalResources.fileSystemRepresentation);
    BOOL modelLoaded = assetsLoaded && self->_runner.load_model(canonicalModel.fileSystemRepresentation);
    if (modelLoaded) {
      self->_runner.set_volume_db(-18.0f);
      self->_runner.set_bypass(true);
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      const BOOL current = self->_lifecycleGeneration.load() == generation;
      self->_loading.store(false);
      self->_renderState->loaded.store(modelLoaded && current, std::memory_order_release);
      self->_playing.store(false);
      self->_stopped.store(false);
      self->_playbackRevision.fetch_add(1);
      self->_modelName = modelLoaded && current ? [modelName copy] : @"";
      [self updateNowPlaying];
      completion(modelLoaded && current, modelLoaded && current ? @"" : @"The model or shared resources could not be loaded.");
    });
  });
#else
  (void)root;
  completion(NO, @"This helper was built without the Magenta inference stack.");
#endif
}

- (void)setPrompts:(NSArray<NSString *> *)prompts weights:(NSArray<NSNumber *> *)weights completion:(void (^)(BOOL, NSString *))completion {
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _promptReady.store(false, std::memory_order_release);
  [self clearNowPlaying];
  NSString *summary = prompt_mix_summary(prompts);
  const std::uint64_t generation = _lifecycleGeneration.fetch_add(1) + 1;
  std::vector<std::string> nativePrompts;
  std::vector<float> nativeWeights;
  for (NSUInteger index = 0; index < prompts.count; ++index) {
    nativePrompts.emplace_back(prompts[index].UTF8String);
    nativeWeights.push_back(weights[index].floatValue);
  }
  dispatch_async(_lifecycleQueue, ^{
    self->_runner.set_text_prompts(nativePrompts, nativeWeights);
    int encoderStatus = self->_runner.get_text_encoder_status();
    int quantizerStatus = self->_runner.get_quantizer_status();
    while (encoderStatus == 1 || quantizerStatus == 1) {
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
      encoderStatus = self->_runner.get_text_encoder_status();
      quantizerStatus = self->_runner.get_quantizer_status();
    }
    const BOOL current = self->_lifecycleGeneration.load() == generation;
    const BOOL succeeded = current && encoderStatus == 2 && quantizerStatus == 2;
    dispatch_async(dispatch_get_main_queue(), ^{
      self->_promptReady.store(succeeded, std::memory_order_release);
      if (succeeded) self->_promptSummary = summary;
      [self updateNowPlaying];
      completion(succeeded, succeeded ? @"" : (current ? @"The prompt encoder failed." : @"Prompt encoding was superseded."));
      write_json(event(@"promptEncoding", @{@"state": succeeded ? @"ready" : @"failed"}));
    });
  });
#else
  (void)prompts;
  (void)weights;
  completion(NO, @"This helper was built without the Magenta inference stack.");
#endif
}

- (void)setWeights:(NSArray<NSNumber *> *)weights {
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  float nativeWeights[6] = {};
  for (NSUInteger index = 0; index < weights.count; ++index) nativeWeights[index] = weights[index].floatValue;
  _runner.set_blend_weights(nativeWeights, static_cast<int>(weights.count));
#else
  (void)weights;
#endif
}

- (void)setVolumeDB:(float)volumeDB {
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _runner.set_volume_db(volumeDB);
#else
  (void)volumeDB;
#endif
}

- (void)setDrumless:(BOOL)drumless {
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _runner.set_drumless(drumless);
#else
  (void)drumless;
#endif
}

- (void)setVariation:(float)variation {
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  const VariationUpdate update = variation_update(variation);
  _runner.set_seed_rotation(update.seedRotation);
  if (update.triggerReset) _runner.trigger_reset();
#else
  (void)variation;
#endif
}

- (void)setBenchmarkMode:(BOOL)enabled {
  _benchmarkMode = enabled;
  _renderState->forceSilent.store(enabled, std::memory_order_release);
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  if (enabled) _runner.set_seed_rotation(0);
#endif
  if (enabled || ![self playing]) [self clearNowPlaying];
  else [self updateNowPlaying];
}

- (void)play {
  if (_systemSuspended.load(std::memory_order_acquire)) return;
  if ((![self loaded] || !_promptReady.load(std::memory_order_acquire)) &&
      !_renderState->selfTestTone.load()) return;
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _runner.set_bypass(false);
#endif
  _playing.store(true, std::memory_order_release);
  _stopped.store(false, std::memory_order_release);
  _playbackRevision.fetch_add(1);
  _renderState->targetGain.store(1.0f);
  [self updateNowPlaying];
}

- (void)pause {
  _playing.store(false, std::memory_order_release);
  _stopped.store(false, std::memory_order_release);
  _playbackRevision.fetch_add(1);
  _renderState->targetGain.store(0.0f);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
    if (!self->_playing.load(std::memory_order_acquire)) self->_runner.set_bypass(true);
#endif
  });
  [self updateNowPlaying];
}

- (void)suspendForSystemSleep {
  _systemSuspended.store(true, std::memory_order_release);
  _suspendGeneration.fetch_add(1);
  [self pause];
  [self clearNowPlaying];
}

- (void)resumeFromSystemSleep {
  _systemSuspended.store(false, std::memory_order_release);
}

- (void)stop {
  [self pause];
  _stopped.store(true, std::memory_order_release);
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _runner.trigger_reset();
#endif
  [self clearNowPlaying];
}

- (NSDictionary *)playbackResult {
  NSString *state = playback_state([self loaded], [self playing],
                                     _stopped.load(std::memory_order_acquire));
  return @{ @"state": state, @"revision": @(_playbackRevision.load()) };
}

- (void)reset {
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  _runner.trigger_reset();
#endif
}

- (void)unloadWithCompletion:(void (^)(void))completion {
  _lifecycleGeneration.fetch_add(1);
  [self pause];
  _benchmarkMode = NO;
  _renderState->loaded.store(false, std::memory_order_release);
  _renderState->forceSilent.store(false, std::memory_order_release);
  _promptReady.store(false, std::memory_order_release);
  _stopped.store(true, std::memory_order_release);
  _modelName = @"";
  _promptSummary = @"On-device mix";
  _playbackRevision.fetch_add(1);
  [self clearNowPlaying];
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  dispatch_async(_lifecycleQueue, ^{
    self->_runner.unload();
    dispatch_async(dispatch_get_main_queue(), completion);
  });
#else
  completion();
#endif
}

- (NSDictionary *)metrics {
  NSMutableArray<NSNumber *> *visualizerBands =
      [NSMutableArray arrayWithCapacity:kVisualizerBandCount];
  for (const auto& band : _renderState->visualizerBands) {
    [visualizerBands addObject:@(std::clamp(
        band.load(std::memory_order_relaxed), 0.0f, 1.0f))];
  }
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
  auto metrics = _runner.get_metrics();
  return @{
    @"transformerMs": @(metrics.transformer_ms),
    @"frameMs": @(metrics.total_ms),
    @"bufferAvailable": @(metrics.buffer_available),
    @"bufferCapacity": @(metrics.buffer_capacity),
    @"droppedFrames": @(metrics.dropped_frames),
    @"visualizerBands": visualizerBands,
  };
#else
  return @{@"transformerMs": @0, @"frameMs": @0, @"bufferAvailable": @0,
           @"bufferCapacity": @0, @"droppedFrames": @0,
           @"visualizerBands": visualizerBands};
#endif
}

- (void)configureRemoteCommands {
  MPRemoteCommandCenter *center = MPRemoteCommandCenter.sharedCommandCenter;
  center.playCommand.enabled = NO;
  center.pauseCommand.enabled = NO;
  center.togglePlayPauseCommand.enabled = NO;
  center.stopCommand.enabled = NO;
  center.nextTrackCommand.enabled = NO;
  center.previousTrackCommand.enabled = NO;
  center.skipForwardCommand.enabled = NO;
  center.skipBackwardCommand.enabled = NO;
  center.changePlaybackPositionCommand.enabled = NO;
  center.seekForwardCommand.enabled = NO;
  center.seekBackwardCommand.enabled = NO;
  center.changePlaybackRateCommand.enabled = NO;
  center.changeRepeatModeCommand.enabled = NO;
  center.changeShuffleModeCommand.enabled = NO;
  center.ratingCommand.enabled = NO;
  center.likeCommand.enabled = NO;
  center.dislikeCommand.enabled = NO;
  center.bookmarkCommand.enabled = NO;
  center.enableLanguageOptionCommand.enabled = NO;
  center.disableLanguageOptionCommand.enabled = NO;
  __weak AmbientAudioController *weakSelf = self;
  [center.playCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *) {
    AmbientAudioController *strongSelf = weakSelf;
    if (!strongSelf) return MPRemoteCommandHandlerStatusNoSuchContent;
    const std::uint64_t generation = strongSelf->_suspendGeneration.load();
    if (!remote_command_allowed(strongSelf.loaded,
                                strongSelf->_promptReady.load(std::memory_order_acquire),
                                strongSelf->_benchmarkMode,
                                strongSelf->_systemSuspended.load(std::memory_order_acquire))) return MPRemoteCommandHandlerStatusNoSuchContent;
    dispatch_async(dispatch_get_main_queue(), ^{
      AmbientAudioController *current = weakSelf;
      if (!current || current->_suspendGeneration.load() != generation ||
          current->_systemSuspended.load(std::memory_order_acquire)) return;
      [current play];
      write_json(event(@"remoteCommand", @{
        @"command": @"play", @"playback": [current playbackResult]
      }));
    });
    return MPRemoteCommandHandlerStatusSuccess;
  }];
  [center.pauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *) {
    AmbientAudioController *strongSelf = weakSelf;
    if (!strongSelf) return MPRemoteCommandHandlerStatusNoSuchContent;
    const std::uint64_t generation = strongSelf->_suspendGeneration.load();
    if (!remote_command_allowed(strongSelf.loaded,
                                strongSelf->_promptReady.load(std::memory_order_acquire),
                                strongSelf->_benchmarkMode,
                                strongSelf->_systemSuspended.load(std::memory_order_acquire))) return MPRemoteCommandHandlerStatusNoSuchContent;
    dispatch_async(dispatch_get_main_queue(), ^{
      AmbientAudioController *current = weakSelf;
      if (!current || current->_suspendGeneration.load() != generation ||
          current->_systemSuspended.load(std::memory_order_acquire)) return;
      [current pause];
      write_json(event(@"remoteCommand", @{
        @"command": @"pause", @"playback": [current playbackResult]
      }));
    });
    return MPRemoteCommandHandlerStatusSuccess;
  }];
  [center.togglePlayPauseCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *) {
    AmbientAudioController *strongSelf = weakSelf;
    if (!strongSelf) return MPRemoteCommandHandlerStatusNoSuchContent;
    const std::uint64_t generation = strongSelf->_suspendGeneration.load();
    if (!remote_command_allowed(strongSelf.loaded,
                                strongSelf->_promptReady.load(std::memory_order_acquire),
                                strongSelf->_benchmarkMode,
                                strongSelf->_systemSuspended.load(std::memory_order_acquire))) return MPRemoteCommandHandlerStatusNoSuchContent;
    dispatch_async(dispatch_get_main_queue(), ^{
      AmbientAudioController *current = weakSelf;
      if (!current || current->_suspendGeneration.load() != generation ||
          current->_systemSuspended.load(std::memory_order_acquire)) return;
      current.playing ? [current pause] : [current play];
      write_json(event(@"remoteCommand", @{
        @"command": @"toggle", @"playback": [current playbackResult]
      }));
    });
    return MPRemoteCommandHandlerStatusSuccess;
  }];
  [center.stopCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *) {
    AmbientAudioController *strongSelf = weakSelf;
    if (!strongSelf) return MPRemoteCommandHandlerStatusNoSuchContent;
    const std::uint64_t generation = strongSelf->_suspendGeneration.load();
    if (!remote_command_allowed(strongSelf.loaded,
                                strongSelf->_promptReady.load(std::memory_order_acquire),
                                strongSelf->_benchmarkMode,
                                strongSelf->_systemSuspended.load(std::memory_order_acquire))) return MPRemoteCommandHandlerStatusNoSuchContent;
    dispatch_async(dispatch_get_main_queue(), ^{
      AmbientAudioController *current = weakSelf;
      if (!current || current->_suspendGeneration.load() != generation ||
          current->_systemSuspended.load(std::memory_order_acquire)) return;
      [current stop];
      write_json(event(@"remoteCommand", @{
        @"command": @"stop", @"playback": [current playbackResult]
      }));
    });
    return MPRemoteCommandHandlerStatusSuccess;
  }];
}

- (void)updateNowPlaying {
  if (!now_playing_allowed(
          [self loaded],
          _promptReady.load(std::memory_order_acquire),
          _benchmarkMode,
          _stopped.load(std::memory_order_acquire),
          _systemSuspended.load(std::memory_order_acquire))) {
    [self clearNowPlaying];
    return;
  }
  MPRemoteCommandCenter *commands = MPRemoteCommandCenter.sharedCommandCenter;
  commands.playCommand.enabled = YES;
  commands.pauseCommand.enabled = YES;
  commands.togglePlayPauseCommand.enabled = YES;
  commands.stopCommand.enabled = YES;
  MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
  center.nowPlayingInfo = now_playing_metadata(_promptSummary, [self playing], _artwork);
  center.playbackState = [self playing] ? MPNowPlayingPlaybackStatePlaying : MPNowPlayingPlaybackStatePaused;
}

- (void)clearNowPlaying {
  MPRemoteCommandCenter *commands = MPRemoteCommandCenter.sharedCommandCenter;
  commands.playCommand.enabled = NO;
  commands.pauseCommand.enabled = NO;
  commands.togglePlayPauseCommand.enabled = NO;
  commands.stopCommand.enabled = NO;
  MPNowPlayingInfoCenter *center = MPNowPlayingInfoCenter.defaultCenter;
  center.playbackState = MPNowPlayingPlaybackStateStopped;
  center.nowPlayingInfo = nil;
}

- (void)prepareForTerminationWithCompletion:(void (^)(void))completion {
  if (_terminating) return;
  _terminating = YES;
  _lifecycleGeneration.fetch_add(1);
  [self pause];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    self->_renderState->loaded.store(false, std::memory_order_release);
#if AIDEN_AMBIENT_MUSIC_WITH_MAGENTA
    dispatch_async(self->_lifecycleQueue, ^{
      self->_runner.set_bypass(true);
      self->_runner.unload();
      dispatch_async(dispatch_get_main_queue(), ^{
        [self->_audioEngine stop];
        self->_audioEngine = nil;
        [self clearNowPlaying];
        completion();
      });
    });
#else
    [self->_audioEngine stop];
    self->_audioEngine = nil;
    [self clearNowPlaying];
    completion();
#endif
  });
}

- (void)prepareForTermination {
  [self prepareForTerminationWithCompletion:^{}];
}

- (void)runMutedSelfTest:(void (^)(BOOL, NSString *))completion {
  NSError *error = nil;
  if (![self startAudio:&error]) {
    completion(NO, error.localizedDescription ?: @"AVAudioEngine did not start.");
    return;
  }
  _renderState->selfTestTone.store(true);
  _renderState->forceSilent.store(true);
  _renderState->targetGain.store(1.0f);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 150 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    float peakLevel = 0.0f;
    for (const auto& band : self->_renderState->visualizerBands) {
      peakLevel = std::max(peakLevel, band.load(std::memory_order_relaxed));
    }
    self->_renderState->selfTestTone.store(false);
    self->_renderState->targetGain.store(0.0f);
    self->_renderState->forceSilent.store(false);
    [self->_audioEngine stop];
    completion(peakLevel > 0.1f, peakLevel > 0.1f ? @"" : @"The muted spectrum self-test failed.");
  });
}

@end

NSArray<NSNumber *> *normalized_weights(NSArray *values) {
  NSMutableArray<NSNumber *> *weights = [NSMutableArray arrayWithCapacity:values.count];
  double sum = 0;
  for (id value in values) {
    if (![value isKindOfClass:NSNumber.class] || is_json_boolean(value)) return nil;
    const double weight = [value doubleValue];
    if (!std::isfinite(weight) || weight < 0 || weight > 1) return nil;
    [weights addObject:@(weight)];
    sum += weight;
  }
  if (sum <= 0) return nil;
  for (NSUInteger index = 0; index < weights.count; ++index) {
    weights[index] = @(weights[index].doubleValue / sum);
  }
  return weights;
}

void handle_request(AmbientAudioController *controller, NSDictionary *request) {
  static NSMutableSet<NSString *> *seen_ids = [NSMutableSet set];
  static NSMutableArray<NSString *> *seen_order = [NSMutableArray array];
  NSString *request_id = request[@"requestId"];
  NSString *method = request[@"method"];
  if (!is_json_integer(request[@"version"]) || [request[@"version"] integerValue] != kProtocolVersion) {
    write_json(response(request_id, NO, @{}, @"unsupported_protocol", @"Unsupported helper protocol version."));
    return;
  }
  if (!is_safe_identifier(request_id, 128) || ![method isKindOfClass:NSString.class]) {
    write_json(response(request_id, NO, @{}, @"invalid_request", @"Invalid request envelope."));
    return;
  }
  if ([seen_ids containsObject:request_id]) {
    write_json(response(request_id, NO, @{}, @"duplicate_request", @"This request identifier was already used."));
    return;
  }
  [seen_ids addObject:request_id];
  [seen_order addObject:request_id];
  if (seen_order.count > 2048) {
    [seen_ids removeObject:seen_order.firstObject];
    [seen_order removeObjectAtIndex:0];
  }
  id rawParams = request[@"params"];
  if (rawParams && ![rawParams isKindOfClass:NSDictionary.class]) {
    write_json(response(request_id, NO, @{}, @"invalid_request", @"Request parameters must be an object."));
    return;
  }
  NSDictionary *params = rawParams ?: @{};
  if ([method isEqualToString:@"hello"]) {
    write_json(response(request_id, YES, @{
      @"protocolVersion": @(kProtocolVersion),
      @"magentaEnabled": @(!!AIDEN_AMBIENT_MUSIC_WITH_MAGENTA),
      @"sampleRate": @(kSampleRate),
      @"channels": @(kChannels),
      @"buildIdentity": [NSString stringWithUTF8String:kBuildIdentity],
    }));
  } else if ([method isEqualToString:@"load"]) {
    NSString *model = params[@"model"];
    NSNumber *benchmarkMode = params[@"benchmarkMode"];
    if (!approved_model_root || !is_safe_identifier(model) || !is_json_boolean(benchmarkMode)) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Invalid model load request."));
      return;
    }
    // Benchmark isolation is part of the load transaction: exact silence and
    // disabled media controls are established before `loaded` can be observed.
    [controller setBenchmarkMode:benchmarkMode.boolValue];
    [controller loadModelRoot:approved_model_root modelName:model completion:^(BOOL ok, NSString *message) {
      write_json(ok ? response(request_id, YES, @{@"model": model, @"playback": [controller playbackResult]})
                    : response(request_id, NO, @{}, @"model_load_failed", message));
    }];
  } else if ([method isEqualToString:@"setPrompts"]) {
    NSArray *prompts = params[@"prompts"];
    NSArray *rawWeights = params[@"weights"];
    if (![prompts isKindOfClass:NSArray.class] || prompts.count < 1 || prompts.count > 6 ||
        ![rawWeights isKindOfClass:NSArray.class] || rawWeights.count != prompts.count) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Provide one to six prompts and matching weights."));
      return;
    }
    NSMutableArray<NSString *> *safePrompts = [NSMutableArray arrayWithCapacity:prompts.count];
    for (id prompt in prompts) {
      if (![prompt isKindOfClass:NSString.class] || [prompt lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 500 ||
          contains_forbidden_prompt_character(prompt)) {
        write_json(response(request_id, NO, @{}, @"invalid_request", @"A prompt is invalid or too long."));
        return;
      }
      NSString *trimmed = [prompt stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (!trimmed.length) {
        write_json(response(request_id, NO, @{}, @"invalid_request", @"Prompts cannot be empty."));
        return;
      }
      [safePrompts addObject:trimmed];
    }
    NSArray<NSNumber *> *weights = normalized_weights(rawWeights);
    if (!weights) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Prompt weights are invalid."));
      return;
    }
    [controller setPrompts:safePrompts weights:weights completion:^(BOOL ok, NSString *message) {
      write_json(ok ? response(request_id, YES, @{@"weights": weights}) :
                    response(request_id, NO, @{}, @"prompt_encoding_failed", message));
    }];
  } else if ([method isEqualToString:@"setWeights"]) {
    NSArray *rawWeights = params[@"weights"];
    if (![rawWeights isKindOfClass:NSArray.class] || rawWeights.count < 1 || rawWeights.count > 6) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Provide one to six prompt weights."));
      return;
    }
    NSArray<NSNumber *> *weights = normalized_weights(rawWeights);
    if (!weights) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Prompt weights are invalid."));
      return;
    }
    [controller setWeights:weights];
    write_json(response(request_id, YES, @{@"weights": weights}));
  } else if ([method isEqualToString:@"setVolume"]) {
    NSNumber *volume = params[@"decibels"];
    if (![volume isKindOfClass:NSNumber.class] || is_json_boolean(volume) || !std::isfinite(volume.doubleValue) || volume.doubleValue < -60 || volume.doubleValue > 0) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Volume must be between -60 dB and 0 dB."));
      return;
    }
    [controller setVolumeDB:volume.floatValue];
    write_json(response(request_id, YES));
  } else if ([method isEqualToString:@"setDrumless"]) {
    NSNumber *enabled = params[@"enabled"];
    if (!is_json_boolean(enabled)) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Drumless must be a boolean."));
      return;
    }
    [controller setDrumless:enabled.boolValue];
    write_json(response(request_id, YES));
  } else if ([method isEqualToString:@"setVariation"]) {
    NSNumber *variation = params[@"variation"];
    if (![variation isKindOfClass:NSNumber.class] || is_json_boolean(variation) ||
        !std::isfinite(variation.doubleValue) || variation.doubleValue < 0 || variation.doubleValue > 1) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Variation must be between zero and one."));
      return;
    }
    [controller setVariation:variation.floatValue];
    write_json(response(request_id, YES));
  } else if ([method isEqualToString:@"setBenchmarkMode"]) {
    NSNumber *enabled = params[@"enabled"];
    if (!is_json_boolean(enabled)) {
      write_json(response(request_id, NO, @{}, @"invalid_request", @"Benchmark mode must be a boolean."));
      return;
    }
    [controller setBenchmarkMode:enabled.boolValue];
    write_json(response(request_id, YES));
  } else if ([method isEqualToString:@"play"]) {
    [controller play];
    write_json(controller.loaded ? response(request_id, YES, @{@"playback": [controller playbackResult]}) :
               response(request_id, NO, @{}, @"model_not_loaded", @"Download and load a model before playing."));
  } else if ([method isEqualToString:@"pause"]) {
    [controller pause];
    write_json(response(request_id, YES, @{@"playback": [controller playbackResult]}));
  } else if ([method isEqualToString:@"suspend"]) {
    [controller suspendForSystemSleep];
    write_json(response(request_id, YES, @{@"playback": [controller playbackResult]}));
  } else if ([method isEqualToString:@"resume"]) {
    [controller resumeFromSystemSleep];
    write_json(response(request_id, YES));
  } else if ([method isEqualToString:@"stop"]) {
    [controller stop];
    write_json(response(request_id, YES, @{@"playback": [controller playbackResult]}));
  } else if ([method isEqualToString:@"reset"]) {
    [controller reset];
    write_json(response(request_id, YES));
  } else if ([method isEqualToString:@"metrics"]) {
    write_json(response(request_id, YES, [controller metrics]));
  } else if ([method isEqualToString:@"idleUnload"]) {
    if (controller.playing) {
      write_json(response(request_id, YES, @{
        @"skipped": @YES, @"playback": [controller playbackResult]
      }));
    } else {
      [controller unloadWithCompletion:^{
        write_json(response(request_id, YES, @{
          @"skipped": @NO, @"playback": [controller playbackResult]
        }));
      }];
    }
  } else if ([method isEqualToString:@"unload"]) {
    [controller unloadWithCompletion:^{
      write_json(response(request_id, YES, @{@"playback": [controller playbackResult]}));
    }];
  } else if ([method isEqualToString:@"shutdown"]) {
    [controller prepareForTerminationWithCompletion:^{
      write_json(response(request_id, YES));
      _exit(0);
    }];
  } else {
    write_json(response(request_id, NO, @{}, @"unknown_method", @"Unknown helper method."));
  }
}

int run_self_test() {
  @autoreleasepool {
    fprintf(stdout, "simulated third-party diagnostic\n");
    fflush(stdout);
    __block int result = 1;
    const VariationUpdate variation = variation_update(0.375f);
    NSString *boundedSummary = prompt_mix_summary(@[
      [@"a" stringByPaddingToLength:140 withString:@"a" startingAtIndex:0], @"second"
    ]);
    NSImage *testArtworkImage = [[NSImage alloc] initWithSize:NSMakeSize(512, 512)];
    MPMediaItemArtwork *testArtwork = [[MPMediaItemArtwork alloc]
        initWithBoundsSize:testArtworkImage.size
        requestHandler:^NSImage *(CGSize) { return testArtworkImage; }];
    NSDictionary *metadata = now_playing_metadata(@"warm pads +1", YES, testArtwork);
    const BOOL controlContractsVerified =
        !remote_command_allowed(false, false, false, false) &&
        !remote_command_allowed(true, false, false, false) &&
        !remote_command_allowed(true, true, true, false) &&
        !remote_command_allowed(true, true, false, true) &&
        remote_command_allowed(true, true, false, false) &&
        !now_playing_allowed(true, true, false, true, false) &&
        !now_playing_allowed(true, true, false, false, true) &&
        now_playing_allowed(true, true, false, false, false) &&
        route_recovery_preserves_terminal_state(true, false) &&
        route_recovery_preserves_terminal_state(false, true) &&
        !route_recovery_preserves_terminal_state(false, false) &&
        normalized_visualizer_level(0.0f) == 0.0f &&
        normalized_visualizer_level(1.0f) == 1.0f &&
        normalized_visualizer_level(0.01f) > 0.5f &&
        normalized_visualizer_level(0.01f) < 0.55f &&
        visualizer_filter_bank_contracts_verified() &&
        variation.seedRotation == 375 && variation.triggerReset &&
        boundedSummary.length <= 99 && [boundedSummary hasSuffix:@" +1"] &&
        [metadata[MPMediaItemPropertyArtist] isEqualToString:@"Aiden · Generated on this Mac"] &&
        [metadata[MPMediaItemPropertyAlbumTitle] isEqualToString:@"warm pads +1"] &&
        [metadata[MPNowPlayingInfoPropertyPlaybackRate] isEqual:@1.0] &&
        metadata[MPMediaItemPropertyArtwork] != nil &&
        metadata[MPMediaItemPropertyPlaybackDuration] == nil &&
        [playback_state(YES, NO, YES) isEqualToString:@"stopped"] &&
        [playback_state(YES, NO, NO) isEqualToString:@"paused"] &&
        [playback_state(YES, YES, NO) isEqualToString:@"playing"];
    if (!controlContractsVerified) {
      write_json(@{
        @"version": @(kProtocolVersion),
        @"ok": @NO,
        @"audio": @"unavailable",
        @"nowPlayingAPI": @"available",
        @"controlContracts": @"failed",
        @"magentaEnabled": @(!!AIDEN_AMBIENT_MUSIC_WITH_MAGENTA),
        @"buildIdentity": [NSString stringWithUTF8String:kBuildIdentity],
        @"message": @"Remote command or variation-reset contract failed.",
      });
      return 1;
    }
    AmbientAudioController *controller = [[AmbientAudioController alloc] init];
    MPRemoteCommandCenter *commands = MPRemoteCommandCenter.sharedCommandCenter;
    const BOOL mediaPolicyVerified =
        !commands.nextTrackCommand.enabled &&
        !commands.previousTrackCommand.enabled &&
        !commands.skipForwardCommand.enabled &&
        !commands.skipBackwardCommand.enabled &&
        !commands.changePlaybackPositionCommand.enabled &&
        !commands.seekForwardCommand.enabled &&
        !commands.seekBackwardCommand.enabled &&
        !commands.changePlaybackRateCommand.enabled &&
        !commands.changeRepeatModeCommand.enabled &&
        !commands.changeShuffleModeCommand.enabled &&
        !commands.ratingCommand.enabled &&
        !commands.likeCommand.enabled &&
        !commands.dislikeCommand.enabled &&
        !commands.bookmarkCommand.enabled &&
        !commands.enableLanguageOptionCommand.enabled &&
        !commands.disableLanguageOptionCommand.enabled;
    if (!mediaPolicyVerified) {
      write_json(@{
        @"version": @(kProtocolVersion),
        @"ok": @NO,
        @"audio": @"unavailable",
        @"nowPlayingAPI": @"available",
        @"controlContracts": @"failed",
        @"magentaEnabled": @(!!AIDEN_AMBIENT_MUSIC_WITH_MAGENTA),
        @"buildIdentity": [NSString stringWithUTF8String:kBuildIdentity],
        @"message": @"Unsupported media commands were not disabled.",
      });
      return 1;
    }
    [controller runMutedSelfTest:^(BOOL ok, NSString *message) {
      write_json(@{
        @"version": @(kProtocolVersion),
        @"ok": @(ok),
        @"audio": ok ? @"ready" : @"unavailable",
        @"nowPlayingAPI": @"available",
        @"controlContracts": @"verified",
        @"magentaEnabled": @(!!AIDEN_AMBIENT_MUSIC_WITH_MAGENTA),
        @"buildIdentity": [NSString stringWithUTF8String:kBuildIdentity],
        @"message": message,
      });
      result = ok ? 0 : 1;
      [NSApp stop:nil];
      NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
          location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
      [NSApp postEvent:event atStart:NO];
    }];
    [NSApplication sharedApplication];
    [NSApp run];
    [controller prepareForTermination];
    return result;
  }
}

void decode_and_dispatch_line(AmbientAudioController *controller, const std::string &line) {
  if (line.empty()) return;
  NSData *data = [NSData dataWithBytes:line.data() length:line.size()];
  NSError *error = nil;
  id decoded = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error || ![decoded isKindOfClass:NSDictionary.class]) {
    write_json(response(@"", NO, @{}, @"invalid_request", @"Invalid JSON request."));
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{ handle_request(controller, decoded); });
}

struct InputBuffer {
  std::string pending;
  bool discardingOversizedLine = false;
};

int main(int argc, const char *argv[]) {
  if (!isolate_protocol_output()) return 3;
  if (argc == 2 && std::string(argv[1]) == "--self-test") return run_self_test();
  @autoreleasepool {
    if (argc == 3 && std::string(argv[1]) == "--model-root") {
      approved_model_root = canonical_existing_path([NSString stringWithUTF8String:argv[2]]);
      if (!approved_model_root) {
        write_json(event(@"fatal", @{@"code": @"invalid_model_root", @"message": @"The approved model root does not exist."}));
        return 2;
      }
    } else if (argc != 1) {
      write_json(event(@"fatal", @{@"code": @"invalid_arguments", @"message": @"Use --model-root with one canonical install root."}));
      return 2;
    }
    [NSApplication sharedApplication];
    AmbientAudioController *controller = [[AmbientAudioController alloc] init];
    NSError *audioError = nil;
    if (![controller startAudio:&audioError]) {
      write_json(event(@"fatal", @{@"code": @"audio_unavailable", @"message": audioError.localizedDescription ?: @"Audio output is unavailable."}));
      return 1;
    }
    write_json(event(@"ready", @{
      @"protocolVersion": @(kProtocolVersion),
      @"magentaEnabled": @(!!AIDEN_AMBIENT_MUSIC_WITH_MAGENTA),
      @"buildIdentity": [NSString stringWithUTF8String:kBuildIdentity],
      @"modelRootApproved": @(approved_model_root != nil),
    }));

    const int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags < 0 || fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) < 0) {
      write_json(event(@"fatal", @{@"code": @"stdin_unavailable", @"message": @"The command channel is unavailable."}));
      return 1;
    }
    auto inputBuffer = std::make_shared<InputBuffer>();
    dispatch_queue_t inputQueue = dispatch_queue_create(
        "com.sambitcreate.aiden-agent.ambient-music.input", DISPATCH_QUEUE_SERIAL);
    dispatch_source_t inputSource = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, inputQueue);
    dispatch_source_set_event_handler(inputSource, ^{
      char chunk[4096];
      while (true) {
        const ssize_t count = read(STDIN_FILENO, chunk, sizeof(chunk));
        if (count == 0) {
          dispatch_source_cancel(inputSource);
          dispatch_async(dispatch_get_main_queue(), ^{
            [controller prepareForTerminationWithCompletion:^{ _exit(0); }];
          });
          return;
        }
        if (count < 0) {
          if (errno == EAGAIN || errno == EWOULDBLOCK) break;
          dispatch_source_cancel(inputSource);
          dispatch_async(dispatch_get_main_queue(), ^{
            [controller prepareForTerminationWithCompletion:^{ _exit(1); }];
          });
          return;
        }
        for (ssize_t index = 0; index < count; ++index) {
          const char character = chunk[index];
          if (inputBuffer->discardingOversizedLine) {
            if (character == '\n') inputBuffer->discardingOversizedLine = false;
            continue;
          }
          if (character == '\n') {
            decode_and_dispatch_line(controller, inputBuffer->pending);
            inputBuffer->pending.clear();
          } else if (inputBuffer->pending.size() >= kMaximumMessageBytes) {
            inputBuffer->pending.clear();
            inputBuffer->discardingOversizedLine = true;
            write_json(response(@"", NO, @{}, @"invalid_request", @"Helper request is too large."));
          } else {
            inputBuffer->pending.push_back(character);
          }
        }
      }
    });
    dispatch_resume(inputSource);

    signal(SIGTERM, SIG_IGN);
    dispatch_source_t terminationSource = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(terminationSource, ^{
      [controller prepareForTerminationWithCompletion:^{ _exit(0); }];
    });
    dispatch_resume(terminationSource);
    [NSApp run];
  }
  return 0;
}
