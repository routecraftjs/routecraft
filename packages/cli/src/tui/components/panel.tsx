import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

export function Panel({
  title,
  subtitle,
  color = theme.muted,
  width,
  flexGrow,
  paddingX = 1,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  color?: string;
  width?: number;
  flexGrow?: number;
  paddingX?: number;
  children: ReactNode;
}) {
  // Border adds 2 chars per side; padding adds paddingX per side
  const innerWidth = width ? width - 2 - paddingX * 2 : 20;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color}
      paddingX={paddingX}
      width={width}
      flexGrow={flexGrow}
    >
      {title && (
        <>
          {/* Uppercase muted labels mirror the site's mono-label treatment;
              focus is conveyed by the border accent, not the title. */}
          <Text bold dimColor>
            {title}
            {subtitle && <> {subtitle}</>}
          </Text>
          <Text dimColor>{"─".repeat(Math.max(innerWidth, 1))}</Text>
        </>
      )}
      {children}
    </Box>
  );
}
