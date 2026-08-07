import { describe, it, expect } from 'vitest'
import { isCalibrationRun } from '../src/model-profiles.js'
import type { RunConfig } from '../src/runner.js'

/**
 * Issue #35: the single source of truth for "is this a calibration run",
 * read from `RunConfig.calibration` — never from the run name and never
 * from "there happen to be no personas" (an ordinary research run can
 * legitimately have zero personas too, so that alone must not read as
 * calibration).
 */
describe('isCalibrationRun', () => {
  it('is true only when config.calibration is explicitly true', () => {
    const config: RunConfig = { model: 'm', temperature: 1, seeds: [0], calibration: true }
    expect(isCalibrationRun(config)).toBe(true)
  })

  it('is false when the flag is absent', () => {
    const config: RunConfig = { model: 'm', temperature: 1, seeds: [0] }
    expect(isCalibrationRun(config)).toBe(false)
  })

  it('is false when the flag is explicitly false', () => {
    const config: RunConfig = { model: 'm', temperature: 1, seeds: [0], calibration: false }
    expect(isCalibrationRun(config)).toBe(false)
  })
})
