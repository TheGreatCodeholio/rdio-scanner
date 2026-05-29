// Copyright (C) 2019-2026 Chrystian Huot <chrystian.huot@saubeo.solutions>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os/exec"
)

// PeaksBucketCount is the fixed length of the per-call peak envelope we
// store and ship to the archive UI. 32 reads as smooth enough on a
// ~150-px-wide row thumbnail without bloating the DB or the search
// response payload (32 bytes per call).
const PeaksBucketCount = 32

// computeAudioMetrics decodes the supplied M4A bytes to mono PCM at
// 8 kHz via an `ffmpeg -f f32le` subprocess and returns the clip's
// duration (ms) plus a fixed-length peak envelope (32 bytes, each in
// [0, 255] where 255 = full-scale).
//
// The choice of 8 kHz mono matches typical radio audio bandwidth; we
// don't need higher fidelity for envelope detection, and the smaller
// sample count keeps the in-Go bucketing loop trivially fast.
//
// Returns zeroed values + a wrapped error if ffmpeg is unavailable or
// the decode fails — the caller logs and stores zeros, which the UI
// renders as "no duration / no waveform" without breaking layout.
func computeAudioMetrics(audio []byte) (durationMs uint, peaks []byte, err error) {
	if len(audio) == 0 {
		return 0, nil, errors.New("empty audio")
	}

	cmd := exec.Command(
		"ffmpeg",
		"-loglevel", "error",
		"-i", "-",
		"-ac", "1", // force mono — symmetric peaks
		"-ar", "8000", // 8 kHz — enough for voice envelope
		"-f", "f32le", // 32-bit little-endian floats
		"-",
	)
	cmd.Stdin = bytes.NewReader(audio)

	stdout := bytes.NewBuffer(nil)
	stderr := bytes.NewBuffer(nil)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if runErr := cmd.Run(); runErr != nil {
		return 0, nil, errors.New("ffmpeg decode failed: " + runErr.Error() + ": " + stderr.String())
	}

	pcm := stdout.Bytes()
	numSamples := len(pcm) / 4 // float32 = 4 bytes
	if numSamples == 0 {
		return 0, nil, errors.New("ffmpeg produced no PCM samples")
	}

	durationMs = uint(float64(numSamples) / 8000.0 * 1000.0)

	peaks = make([]byte, PeaksBucketCount)
	bucketSamples := numSamples / PeaksBucketCount
	if bucketSamples == 0 {
		bucketSamples = 1
	}

	for i := 0; i < PeaksBucketCount; i++ {
		from := i * bucketSamples * 4
		to := from + bucketSamples*4
		// Last bucket sweeps the tail so we don't drop a few samples
		// to integer-division rounding.
		if i == PeaksBucketCount-1 || to > len(pcm) {
			to = len(pcm)
		}
		var maxAbs float32
		for j := from; j+4 <= to; j += 4 {
			bits := binary.LittleEndian.Uint32(pcm[j : j+4])
			v := math.Float32frombits(bits)
			if v < 0 {
				v = -v
			}
			if v > maxAbs {
				maxAbs = v
			}
		}
		if maxAbs > 1 {
			maxAbs = 1
		}
		peaks[i] = byte(maxAbs * 255)
	}

	return durationMs, peaks, nil
}
