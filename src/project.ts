import { homedir } from "node:os";
import { join } from "node:path";

export function decodeProjectSlug(slug: string): { project: string; cwd: string } {
  const usersPrefix = "Users-";
  const projectsMarker = "-Projects-";
  const projectsIdx = slug.indexOf(projectsMarker);

  if (slug.startsWith(usersPrefix) && projectsIdx > usersPrefix.length) {
    const user = slug.slice(usersPrefix.length, projectsIdx);
    const rest = slug.slice(projectsIdx + projectsMarker.length);
    return {
      project: basenameProject(rest),
      cwd: join("/Users", user, "Projects", rest),
    };
  }

  return {
    project: basenameProject(slug),
    cwd: join(homedir(), ".cursor", "projects", slug),
  };
}

function basenameProject(name: string): string {
  const parts = name.split("/").filter(Boolean);
  return parts[parts.length - 1] || name || "unknown";
}
