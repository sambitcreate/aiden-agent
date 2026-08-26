cmake_minimum_required(VERSION 3.27)

project(AidenAmbientMusicHelper LANGUAGES C CXX OBJCXX)

# SentencePiece v0.2.0 predates CMake 4's removal of legacy compatibility.
# This pin is intentional and reviewed with Magenta RealTime v2.0.3.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5 CACHE STRING "Oldest dependency policy level" FORCE)

if(NOT APPLE)
  message(FATAL_ERROR "The Ambient Music helper is available only on macOS.")
endif()

if(NOT CMAKE_SYSTEM_PROCESSOR STREQUAL "arm64")
  message(FATAL_ERROR "The Ambient Music helper requires Apple Silicon (arm64).")
endif()

set(CMAKE_OSX_ARCHITECTURES "arm64" CACHE STRING "Ambient Music architectures" FORCE)
set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0" CACHE STRING "Minimum supported macOS" FORCE)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 20)
set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)

option(AIDEN_AMBIENT_MUSIC_WITH_MAGENTA "Link the pinned Magenta RealTime inference stack" OFF)

add_executable(aiden-ambient-music-helper src/main.mm)
target_compile_options(aiden-ambient-music-helper PRIVATE -fobjc-arc)
target_link_libraries(aiden-ambient-music-helper PRIVATE
  "-framework AppKit"
  "-framework AVFAudio"
  "-framework Foundation"
  "-framework MediaPlayer"
)

if(AIDEN_AMBIENT_MUSIC_WITH_MAGENTA)
  include(FetchContent)

  # First declarations win in FetchContent. Declare MLX's header inputs here
  # so a future upstream tag or URL change cannot alter Aiden's reviewed build.
  FetchContent_Declare(metal_cpp
    URL https://developer.apple.com/metal/cpp/files/metal-cpp_26.zip
    URL_HASH SHA256=4df3c078b9aadcb516212e9cb03004cbc5ce9a3e9c068fa3144d021db585a3a4
  )
  FetchContent_Declare(json
    URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
    URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d
  )
  FetchContent_Declare(fmt
    GIT_REPOSITORY https://github.com/fmtlib/fmt.git
    GIT_TAG 407c905e45ad75fc29bf0f9bb7c5c2fd3475976f
    GIT_SHALLOW OFF
    EXCLUDE_FROM_ALL
  )

  set(ABSL_INTERNAL_AT_LEAST_CXX20 ON CACHE BOOL "" FORCE)
  set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
  set(MLX_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(MLX_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(MLX_BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
  set(MLX_BUILD_PYTHON_BINDINGS OFF CACHE BOOL "" FORCE)
  set(MLX_BUILD_PYTHON_STUBS OFF CACHE BOOL "" FORCE)
  set(MLX_BUILD_GGUF OFF CACHE BOOL "" FORCE)
  set(MLX_BUILD_CUDA OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(mlx
    GIT_REPOSITORY https://github.com/ml-explore/mlx.git
    GIT_TAG ce45c52505c8158ea48d2a54e8caae05efd86bfe
    GIT_SHALLOW OFF
  )
  FetchContent_GetProperties(mlx)
  if(NOT mlx_POPULATED)
    FetchContent_Populate(mlx)
  endif()

  # MLX v0.31.1 splits header paths on spaces. Keep the upstream-compatible
  # patch until the fix ships in a reviewed, newly pinned MLX release.
  execute_process(
    COMMAND git apply --check --whitespace=nowarn
      "${CMAKE_CURRENT_LIST_DIR}/patches/mlx-header-paths.patch"
    WORKING_DIRECTORY "${mlx_SOURCE_DIR}"
    RESULT_VARIABLE MLX_PATCH_CHECK
    OUTPUT_QUIET
    ERROR_QUIET
  )
  if(NOT MLX_PATCH_CHECK EQUAL 0)
    message(FATAL_ERROR "The reviewed MLX patch does not apply to the pinned source.")
  endif()
  execute_process(
    COMMAND git apply --whitespace=nowarn
      "${CMAKE_CURRENT_LIST_DIR}/patches/mlx-header-paths.patch"
    WORKING_DIRECTORY "${mlx_SOURCE_DIR}"
    COMMAND_ERROR_IS_FATAL ANY
  )
  add_subdirectory("${mlx_SOURCE_DIR}" "${mlx_BINARY_DIR}")

  set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(sentencepiece
    GIT_REPOSITORY https://github.com/google/sentencepiece.git
    GIT_TAG 17d7580d6407802f85855d2cc9190634e2c95624
    GIT_SHALLOW OFF
  )
  FetchContent_MakeAvailable(sentencepiece)

  set(TFLITE_ENABLE_XNNPACK OFF CACHE BOOL "" FORCE)
  set(TFLITE_ENABLE_GPU OFF CACHE BOOL "" FORCE)
  set(TFLITE_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(tensorflow-lite
    GIT_REPOSITORY https://github.com/tensorflow/tensorflow.git
    GIT_TAG a481b10260dfdf833a1b16007eead49c1d7febf3
    SOURCE_SUBDIR tensorflow/lite
    GIT_SHALLOW OFF
  )
  FetchContent_GetProperties(tensorflow-lite)
  if(NOT tensorflow-lite_POPULATED)
    FetchContent_Populate(tensorflow-lite)
  endif()
  # TensorFlow Lite 2.21.0 names FlatBuffers by tag and requests a shallow
  # clone. Apply the checked-in reviewed patch before the module is evaluated.
  execute_process(
    COMMAND git apply --check --whitespace=nowarn
      "${CMAKE_CURRENT_LIST_DIR}/patches/tflite-flatbuffers-pin.patch"
    WORKING_DIRECTORY "${tensorflow-lite_SOURCE_DIR}"
    RESULT_VARIABLE TFLITE_PATCH_CHECK
    OUTPUT_QUIET
    ERROR_QUIET
  )
  if(NOT TFLITE_PATCH_CHECK EQUAL 0)
    message(FATAL_ERROR "The reviewed TensorFlow Lite patch does not apply to the pinned source.")
  endif()
  execute_process(
    COMMAND git apply --whitespace=nowarn
      "${CMAKE_CURRENT_LIST_DIR}/patches/tflite-flatbuffers-pin.patch"
    WORKING_DIRECTORY "${tensorflow-lite_SOURCE_DIR}"
    COMMAND_ERROR_IS_FATAL ANY
  )
  set(FETCHCONTENT_SOURCE_DIR_TENSORFLOW "${tensorflow-lite_SOURCE_DIR}" CACHE PATH "" FORCE)
  add_subdirectory("${tensorflow-lite_SOURCE_DIR}/tensorflow/lite" "${tensorflow-lite_BINARY_DIR}")

  FetchContent_Declare(magenta-realtime
    GIT_REPOSITORY https://github.com/magenta/magenta-realtime.git
    GIT_TAG 694a545e4ba0b88bf1150137b129582166d3e07f
    GIT_SHALLOW OFF
  )
  FetchContent_GetProperties(magenta-realtime)
  if(NOT magenta-realtime_POPULATED)
    FetchContent_Populate(magenta-realtime)
  endif()
  add_subdirectory("${magenta-realtime_SOURCE_DIR}/core" "${magenta-realtime_BINARY_DIR}/core" EXCLUDE_FROM_ALL)

  target_compile_definitions(aiden-ambient-music-helper PRIVATE AIDEN_AMBIENT_MUSIC_WITH_MAGENTA=1)
  target_link_libraries(aiden-ambient-music-helper PRIVATE magentart::core)
endif()

enable_testing()
add_test(NAME ambient-music-helper-self-test
  COMMAND aiden-ambient-music-helper --self-test
)
