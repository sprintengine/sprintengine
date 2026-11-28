import React from 'react'

/**
 * The window around a diff, when the diff is all the window holds: the diff
 * draws the window's top itself, as the editor window does — its files column
 * runs from the window's top with the traffic lights in its corner, and the
 * band over the diff is the rest of the title bar. Null when something else
 * draws the top (the workspace pane's strip, a pop-out holding other tabs).
 */
export type DiffWindowChrome = {
  /** macOS draws its lights in the top-left corner, so the band leaves them room. */
  trafficLights: boolean
  /** The window's own way out on win/linux, drawn at the band's far end. */
  controls: React.ReactNode
}

export const DiffWindowChromeContext = React.createContext<DiffWindowChrome | null>(null)
