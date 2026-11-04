"use client";

import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Volume2, Pause, Loader2, AlertCircle } from "lucide-react";
import type { TtsStatus } from "./use-tts.ts";
import { cn } from "@/lib/utils";

export interface TtsButtonProps {
	status: TtsStatus;
	isPlaying: boolean;
	isLoading: boolean;
	isPaused: boolean;
	errorMessage?: string | null;
	onClick: () => void;
	className?: string;
}

export function TtsButton({
	status,
	isPlaying,
	isLoading,
	isPaused,
	errorMessage,
	onClick,
	className,
}: TtsButtonProps) {
	let icon = <Volume2 className="size-3.5 text-muted-foreground/70 transition-colors group-hover:text-foreground" />;
	let label = "Listen to explanation";

	if (isLoading) {
		icon = <Loader2 className="size-3.5 animate-spin text-muted-foreground" />;
		label = "Loading narration…";
	} else if (isPlaying) {
		icon = <Pause className="size-3.5 text-foreground animate-pulse" />;
		label = "Pause narration";
	} else if (isPaused) {
		icon = <Volume2 className="size-3.5 text-foreground" />;
		label = "Resume narration";
	} else if (status === "error") {
		icon = <AlertCircle className="size-3.5 text-red-500" />;
		label = errorMessage || "Narration failed";
	}

	return (
		<Hint label={label} side="top">
			<Button
				variant="ghost"
				size="icon-xs"
				type="button"
				onClick={onClick}
				aria-label={label}
				data-testid="tts-button"
				className={cn(
					"group relative size-6 rounded-sm p-0 transition-opacity opacity-60 hover:opacity-100",
					isPlaying && "opacity-100 bg-accent text-foreground",
					className,
				)}
			>
				{icon}
			</Button>
		</Hint>
	);
}
