import { describe, expect, it } from "vitest";
import { article, systemSubject, withArticle } from "../../subject";
import { playlistLanding, shortTitle } from "./landing";
import type { Playlist } from "./schema";

// A playlist page's words (landing.ts): what the playlist says, else what its title gives.

const playlist = (extra: Partial<Playlist> = {}) =>
  ({
    slug: "backend-job-scheduler",
    title: "The job scheduler interview",
    summary: "s",
    outline: "o",
    lessons: [],
    ...extra,
  }) as unknown as Playlist;

describe("playlistLanding", () => {
  it("takes the subject from the title", () => {
    expect(playlistLanding(playlist())).toEqual({
      subject: "a job scheduler",
      name: "job scheduler",
      reach: null,
    });
  });

  it("says what the playlist says instead", () => {
    expect(
      playlistLanding(
        playlist({
          landing: { subject: "an Amazon listing page", reach: "the race" },
        }),
      ),
    ).toEqual({
      subject: "an Amazon listing page",
      name: "Amazon listing page",
      reach: "the race",
    });
  });

  it("uses the title as it is when it names no interview", () => {
    expect(
      playlistLanding(playlist({ title: "Proximity search: four ways" }))
        .subject,
    ).toBe("Proximity search: four ways");
  });
});

describe("the subject’s article", () => {
  it.each([
    ["URL shortener", "a URL shortener"],
    ["OTT streaming service", "an OTT streaming service"],
    ["e-commerce platform", "an e-commerce platform"],
    ["online learning platform", "an online learning platform"],
    ["hotel booking system", "a hotel booking system"],
    ["OTT streaming", "OTT streaming"],
    ["proximity search", "proximity search"],
    ["load balancers", "load balancers"],
  ])('says "%s" as "%s"', (name, said) => {
    expect(withArticle(name)).toBe(said);
  });
  it.each([
    ["Job scheduler", "Design a job scheduler", "a job scheduler"],
    ["URL shortener", "Design a uRL shortener", "a URL shortener"],
    ["E-commerce", "Design a e-commerce", "e-commerce"],
    ["Amazon", "Design Amazon", "Amazon"],
    ["Instagram", "Design a photo-sharing web app", "a photo-sharing web app"],
    ["Google Docs", "Design Google Docs", "Google Docs"],
  ])('says the system "%s" (%s) as "%s"', (name, title, said) => {
    expect(systemSubject(name, title)).toBe(said);
  });
  it('says "an" before a letter said with a vowel', () => {
    expect(article("SMS gateway")).toBe("an");
    expect(article("social feed")).toBe("a");
  });
});

describe("shortTitle", () => {
  it("drops the playlist’s lead and capitalizes what is left", () => {
    expect(
      shortTitle("The job scheduler interview: retries and dead executors"),
    ).toBe("Retries and dead executors");
    expect(shortTitle("Follow-ups")).toBe("Follow-ups");
  });
});
