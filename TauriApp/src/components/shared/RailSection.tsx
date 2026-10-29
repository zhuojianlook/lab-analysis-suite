import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckIcon from "@mui/icons-material/Check";
import type { ReactNode } from "react";

/** Numbered step badge; becomes a check once the step is complete. */
function StepBadge({ step, done }: { step: number; done?: boolean }) {
  return (
    <Box
      sx={{
        width: 22,
        height: 22,
        flexShrink: 0,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        fontSize: 11,
        fontWeight: 700,
        bgcolor: done ? "primary.main" : "transparent",
        color: done ? "primary.contrastText" : "text.secondary",
        border: done ? "none" : "1.5px solid",
        borderColor: "divider",
      }}
    >
      {done ? <CheckIcon sx={{ fontSize: 14 }} /> : step}
    </Box>
  );
}

/** One collapsible step of a control rail: badge + title + one-line status
 *  summary in the header. Disabled steps are shown dimmed and can't open. */
export function RailSection({
  step,
  title,
  summary,
  done,
  disabled,
  expanded,
  onToggle,
  children,
}: {
  step: number;
  title: string;
  summary?: ReactNode;
  done?: boolean;
  disabled?: boolean;
  expanded: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Accordion
      disableGutters
      square
      elevation={0}
      disabled={disabled}
      expanded={expanded && !disabled}
      onChange={(_, open) => onToggle(open)}
      slotProps={{ transition: { unmountOnExit: false } }}
      sx={{
        bgcolor: "transparent",
        borderBottom: 1,
        borderColor: "divider",
        "&::before": { display: "none" },
        "&.Mui-disabled": { bgcolor: "transparent" },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon fontSize="small" />}
        sx={{
          px: 1.5,
          minHeight: 52,
          "& .MuiAccordionSummary-content": { my: 1, alignItems: "center", gap: 1.25, minWidth: 0 },
        }}
      >
        <StepBadge step={step} done={done} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ lineHeight: 1.25 }}>{title}</Typography>
          {summary && (
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {summary}
            </Typography>
          )}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pt: 0.5, pb: 2 }}>{children}</AccordionDetails>
    </Accordion>
  );
}

/** Small uppercase group heading inside a rail section. */
export function RailHeading({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <Typography
      variant="overline"
      color="text.secondary"
      sx={{ display: "block", lineHeight: 1.6, fontSize: 10.5, letterSpacing: 0.8, mt: first ? 0 : 2, mb: 0.75 }}
    >
      {children}
    </Typography>
  );
}
