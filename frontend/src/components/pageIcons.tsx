import type { ReactNode } from "react";

import type { PageId } from "../lib/router";
import {
  AgentIcon, BrainIcon, GlobeIcon, GithubIcon, HomeIcon, MapIcon, NewsIcon,
  SatelliteIcon, WeatherIcon, EarthIcon,
} from "./icons";

export const PAGE_ICONS: Record<PageId, (size?: number) => ReactNode> = {
  home: (s) => <HomeIcon size={s} />,
  command: (s) => <GlobeIcon size={s} />,
  agent: (s) => <AgentIcon size={s} />,
  weather: (s) => <WeatherIcon size={s} />,
  earth: (s) => <EarthIcon size={s} />,
  satellites: (s) => <SatelliteIcon size={s} />,
  map: (s) => <MapIcon size={s} />,
  news: (s) => <NewsIcon size={s} />,
  github: (s) => <GithubIcon size={s} />,
  memory: (s) => <BrainIcon size={s} />,
};
