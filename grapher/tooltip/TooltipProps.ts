// We can't pass the property directly because we need it to be observable.
export interface TooltipManager {
    tooltip?: TooltipProps
}

export interface TooltipProps {
    x: number
    y: number
    offsetX?: number
    offsetY?: number
    offsetYDirection?: "upward" | "downward"
    style?: React.CSSProperties
    children?: React.ReactNode
    tooltipManager: TooltipManager
}
