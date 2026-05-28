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
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>
//
// WebSocket API Access Policy:
// This WebSocket API is reserved exclusively for Saubeo Solutions and its native applications.
// Unauthorized access is strictly prohibited.
// See API_ACCESS_POLICY.md for full terms.

package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strconv"
	"strings"
)

type FFMpeg struct {
	available bool
	version43 bool
}

func NewFFMpeg() *FFMpeg {
	ffmpeg := &FFMpeg{}

	stdout := bytes.NewBuffer([]byte(nil))

	cmd := exec.Command("ffmpeg", "-version")
	cmd.Stdout = stdout

	if err := cmd.Run(); err == nil {
		ffmpeg.available = true

		if l, err := stdout.ReadString('\n'); err == nil {
			s := regexp.MustCompile(`.*ffmpeg version .{0,1}([0-9])\.([0-9])\.[0-9].*`).ReplaceAllString(strings.TrimSuffix(l, "\n"), "$1.$2")
			v := strings.Split(s, ".")
			if len(v) > 1 {
				if major, err := strconv.Atoi(v[0]); err == nil {
					if minor, err := strconv.Atoi(v[1]); err == nil {
						if major > 4 || (major == 4 && minor >= 3) {
							ffmpeg.version43 = true
						}
					}
				}
			}
		}
	}

	return ffmpeg
}

// Convert transcodes the incoming audio to M4A (AAC). Conversion to M4A
// happens for every mode — the `mode` argument only selects which (if
// any) loudness-normalization filter to apply.
//
// Modes:
//   AUDIO_CONVERSION_ENABLED           — M4A only, no normalization
//   AUDIO_CONVERSION_ENABLED_NORM      — M4A + EBU R128 loudnorm defaults
//   AUDIO_CONVERSION_ENABLED_LOUD_NORM — M4A + broadcast-loud loudnorm
//                                         (I=-16 LUFS, TP=-1.5, LRA=11)
//
// Output goes to a temp file rather than stdout. A pipe-output forces
// fragmented MP4 (one moof+mdat per AAC frame for audio-only — thousands
// of fragments on long clips, which breaks some decoders). With a temp
// file we can use +faststart so the moov atom lands at the start of a
// properly-structured non-fragmented M4A.
//
// If ffmpeg is unavailable or the run fails, we return an error so the
// controller logs it. The caller currently still stores the call with
// the original audio; install ffmpeg to restore the "always M4A" guarantee.
func (ffmpeg *FFMpeg) Convert(call *Call, systems *Systems, tags *Tags, mode uint) error {
	if !ffmpeg.available {
		return errors.New("ffmpeg is not available, audio cannot be transcoded to M4A")
	}

	tmp, err := os.CreateTemp("", "rdio-ffmpeg-*.m4a")
	if err != nil {
		return fmt.Errorf("ffmpeg: temp output: %w", err)
	}
	tmpName := tmp.Name()
	// Close the handle so ffmpeg can write to it on every platform
	// (Windows would otherwise refuse the open).
	tmp.Close()
	defer os.Remove(tmpName)

	args := []string{"-y", "-i", "-"}

	if tag, ok := tags.GetTagById(call.Talkgroup.TagId); ok {
		args = append(args,
			"-metadata", fmt.Sprintf("album=%v", call.Talkgroup.Label),
			"-metadata", fmt.Sprintf("artist=%v", call.System.Label),
			"-metadata", fmt.Sprintf("date=%v", call.Timestamp),
			"-metadata", fmt.Sprintf("genre=%v", tag),
			"-metadata", fmt.Sprintf("title=%v", call.Talkgroup.Name),
		)
	}

	if ffmpeg.version43 {
		switch mode {
		case AUDIO_CONVERSION_ENABLED_NORM:
			// apad pads to 3s so loudnorm has enough samples to analyze
			// in single-pass mode. The client-side trimSilenceEnd removes
			// the added tail at decode time so it doesn't affect UX.
			args = append(args, "-af", "apad=whole_dur=3s,loudnorm")
		case AUDIO_CONVERSION_ENABLED_LOUD_NORM:
			args = append(args, "-af", "apad=whole_dur=3s,loudnorm=I=-16:TP=-1.5:LRA=11")
		}
	}

	args = append(args,
		"-c:a", "aac",
		"-b:a", "32k",
		"-ac", "1", // force mono so a stereo input doesn't split bits 16/16
		"-movflags", "+faststart",
		tmpName,
	)

	cmd := exec.Command("ffmpeg", args...)
	cmd.Stdin = bytes.NewReader(call.Audio)

	stderr := bytes.NewBuffer(nil)
	cmd.Stderr = stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg conversion failed: %s: %s", err.Error(), strings.TrimSpace(stderr.String()))
	}

	out, err := os.ReadFile(tmpName)
	if err != nil {
		return fmt.Errorf("ffmpeg: read output: %w", err)
	}

	call.Audio = out
	call.AudioFilename = fmt.Sprintf("%v.m4a", strings.TrimSuffix(call.AudioFilename, path.Ext(call.AudioFilename)))
	call.AudioMime = "audio/mp4"

	return nil
}
