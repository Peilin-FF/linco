use std::collections::VecDeque;

use bytes::{Bytes, BytesMut};

use crate::RingReplayError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RingRange {
    pub available_from: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RingReplay {
    pub requested_offset: u64,
    pub next_offset: u64,
    pub range: RingRange,
    pub data: Bytes,
}

#[derive(Debug, Clone)]
struct Segment {
    offset: u64,
    data: Bytes,
}

/// A byte-bounded append-only ring addressed by absolute stream offsets.
///
/// Segment payloads use `Bytes`, so live subscribers and the replay ring share the same allocation.
/// Trimming a partial segment is a zero-copy slice.
#[derive(Debug, Clone)]
pub struct ByteRing {
    capacity: usize,
    stored: usize,
    available_from: u64,
    end: u64,
    segments: VecDeque<Segment>,
}

impl ByteRing {
    pub fn new(capacity: usize) -> Result<Self, &'static str> {
        if capacity == 0 {
            return Err("ring capacity must be non-zero");
        }
        Ok(Self {
            capacity,
            stored: 0,
            available_from: 0,
            end: 0,
            segments: VecDeque::new(),
        })
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn stored_len(&self) -> usize {
        self.stored
    }

    pub fn range(&self) -> RingRange {
        RingRange {
            available_from: self.available_from,
            end: self.end,
        }
    }

    /// Appends a raw output chunk and returns the chunk's absolute starting offset.
    pub fn append(&mut self, data: Bytes) -> Result<u64, RingReplayError> {
        let offset = self.end;
        if data.is_empty() {
            return Ok(offset);
        }

        self.end = self
            .end
            .checked_add(data.len() as u64)
            .ok_or(RingReplayError::OffsetOverflow)?;
        self.stored = self.stored.saturating_add(data.len());
        self.segments.push_back(Segment { offset, data });
        self.trim_to_capacity();
        Ok(offset)
    }

    pub fn replay(
        &self,
        requested_offset: u64,
        max_bytes: usize,
    ) -> Result<RingReplay, RingReplayError> {
        let range = self.range();
        if requested_offset < range.available_from {
            return Err(RingReplayError::Gap {
                requested: requested_offset,
                available_from: range.available_from,
                available_to: range.end,
            });
        }
        if requested_offset > range.end {
            return Err(RingReplayError::FutureOffset {
                requested: requested_offset,
                end: range.end,
            });
        }

        let available = (range.end - requested_offset).min(usize::MAX as u64) as usize;
        let wanted = available.min(max_bytes);
        if wanted == 0 {
            return Ok(RingReplay {
                requested_offset,
                next_offset: requested_offset,
                range,
                data: Bytes::new(),
            });
        }

        let mut output = BytesMut::with_capacity(wanted);
        let mut cursor = requested_offset;
        for segment in &self.segments {
            let segment_end = segment.offset + segment.data.len() as u64;
            if segment_end <= cursor {
                continue;
            }
            if segment.offset > cursor {
                // The ring invariant guarantees contiguous segments.
                break;
            }

            let skip = (cursor - segment.offset) as usize;
            let remaining = wanted - output.len();
            let take = (segment.data.len() - skip).min(remaining);
            output.extend_from_slice(&segment.data[skip..skip + take]);
            cursor += take as u64;
            if output.len() == wanted {
                break;
            }
        }

        Ok(RingReplay {
            requested_offset,
            next_offset: cursor,
            range,
            data: output.freeze(),
        })
    }

    fn trim_to_capacity(&mut self) {
        while self.stored > self.capacity {
            let excess = self.stored - self.capacity;
            let Some(front) = self.segments.front_mut() else {
                self.stored = 0;
                self.available_from = self.end;
                return;
            };

            if front.data.len() <= excess {
                let removed = self.segments.pop_front().expect("front exists");
                self.stored -= removed.data.len();
                self.available_from = removed.offset + removed.data.len() as u64;
            } else {
                front.data = front.data.slice(excess..);
                front.offset += excess as u64;
                self.stored -= excess;
                self.available_from = front.offset;
            }
        }

        if let Some(front) = self.segments.front() {
            self.available_from = front.offset;
        } else {
            self.available_from = self.end;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_is_contiguous_across_segments_and_can_be_limited() {
        let mut ring = ByteRing::new(16).unwrap();
        assert_eq!(ring.append(Bytes::from_static(b"abc")).unwrap(), 0);
        assert_eq!(ring.append(Bytes::from_static(b"defgh")).unwrap(), 3);

        let replay = ring.replay(2, 4).unwrap();
        assert_eq!(&replay.data[..], b"cdef");
        assert_eq!(replay.next_offset, 6);
        assert_eq!(
            replay.range,
            RingRange {
                available_from: 0,
                end: 8
            }
        );
    }

    #[test]
    fn trim_reports_a_precise_gap_and_keeps_the_newest_bytes() {
        let mut ring = ByteRing::new(6).unwrap();
        ring.append(Bytes::from_static(b"abcde")).unwrap();
        ring.append(Bytes::from_static(b"fgh")).unwrap();

        assert_eq!(ring.stored_len(), 6);
        assert_eq!(
            ring.range(),
            RingRange {
                available_from: 2,
                end: 8
            }
        );
        assert_eq!(&ring.replay(2, usize::MAX).unwrap().data[..], b"cdefgh");
        assert_eq!(
            ring.replay(0, 8).unwrap_err(),
            RingReplayError::Gap {
                requested: 0,
                available_from: 2,
                available_to: 8,
            }
        );
    }

    #[test]
    fn oversized_chunk_is_trimmed_without_changing_absolute_offsets() {
        let mut ring = ByteRing::new(4).unwrap();
        let offset = ring.append(Bytes::from_static(b"abcdefghij")).unwrap();
        assert_eq!(offset, 0);
        assert_eq!(
            ring.range(),
            RingRange {
                available_from: 6,
                end: 10
            }
        );
        assert_eq!(&ring.replay(6, 10).unwrap().data[..], b"ghij");
    }

    #[test]
    fn future_offsets_are_rejected_but_end_offset_is_valid() {
        let mut ring = ByteRing::new(4).unwrap();
        ring.append(Bytes::from_static(b"ab")).unwrap();
        assert!(ring.replay(2, 10).unwrap().data.is_empty());
        assert_eq!(
            ring.replay(3, 10).unwrap_err(),
            RingReplayError::FutureOffset {
                requested: 3,
                end: 2
            }
        );
    }
}
