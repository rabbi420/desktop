import { GitError as DugiteError } from 'dugite'

import { Repository } from '../../models/repository'
import {
  IStashEntry,
  StashedChangesLoadStates,
  StashedFileChanges,
} from '../../models/stash-entry'
import { CommittedFileChange } from '../../models/status'

import { git, GitError } from './core'
import { parseChangedFiles } from './log'

export const DesktopStashEntryMarker = '!!GitHub_Desktop'

/**
 * RegEx for determining if a stash entry is created by Desktop
 *
 * This is done by looking for a magic string with the following
 * format: `!!GitHub_Desktop<branch>`
 */
const desktopStashEntryMessageRe = /!!GitHub_Desktop<(.+)>$/

type StashResult = {
  /** The stash entries created by Desktop */
  readonly desktopEntries: ReadonlyArray<IStashEntry>

  /**
   * The total amount of stash entries,
   * i.e. stash entries created both by Desktop and outside of Desktop
   */
  readonly stashEntryCount: number
}

/**
 * Get the list of stash entries created by Desktop in the current repository
 * using the default ordering of refs (which is LIFO ordering),
 * as well as the total amount of stash entries.
 */
export async function getStashes(repository: Repository): Promise<StashResult> {
  const delimiter = '1F'
  const delimiterString = String.fromCharCode(parseInt(delimiter, 16))
  const format = ['%gd', '%H', '%gs'].join(`%x${delimiter}`)

  const result = await git(
    ['log', '-g', '-z', `--pretty=${format}`, 'refs/stash'],
    repository.path,
    'getStashEntries',
    {
      successExitCodes: new Set([0, 128]),
    }
  )

  // There's no refs/stashes reflog in the repository or it's not
  // even a repository. In either case we don't care
  if (result.exitCode === 128) {
    return { desktopEntries: [], stashEntryCount: 0 }
  }

  const desktopStashEntries: Array<IStashEntry> = []
  const files: StashedFileChanges = {
    kind: StashedChangesLoadStates.NotLoaded,
  }

  const entries = result.stdout.split('\0').filter(s => s !== '')
  for (const entry of entries) {
    const pieces = entry.split(delimiterString)

    if (pieces.length === 3) {
      const [name, stashSha, message] = pieces
      const branchName = extractBranchFromMessage(message)

      if (branchName !== null) {
        desktopStashEntries.push({
          name,
          branchName,
          stashSha,
          files,
        })
      }
    }
  }

  return {
    desktopEntries: desktopStashEntries,
    stashEntryCount: entries.length - 1,
  }
}

/**
 * Returns the last Desktop created stash entry for the given branch
 */
export async function getLastDesktopStashEntryForBranch(
  repository: Repository,
  branchName: string
) {
  const stash = await getStashes(repository)

  // Since stash objects are returned in a LIFO manner, the first
  // entry found is guaranteed to be the last entry created
  return (
    stash.desktopEntries.find(stash => stash.branchName === branchName) || null
  )
}

/** Creates a stash entry message that idicates the entry was created by Desktop */
export function createDesktopStashMessage(branchName: string) {
  return `${DesktopStashEntryMarker}<${branchName}>`
}

/**
 * Stash the working directory changes for the current branch
 */
export async function createDesktopStashEntry(
  repository: Repository,
  branchName: string
): Promise<true> {
  await stageUntrackedFiles(repository)

  const message = createDesktopStashMessage(branchName)
  const args = ['stash', 'push', '-m', message]

  const result = await git(args, repository.path, 'createStashEntry', {
    successExitCodes: new Set<number>([0, 1]),
  })

  if (result.exitCode === 1) {
    // search for any line starting with `error:` -  /m here to ensure this is
    // applied to each line, without needing to split the text
    const errorPrefixRe = /^error: /m

    const matches = errorPrefixRe.exec(result.stderr)
    if (matches !== null && matches.length > 0) {
      // rethrow, because these messages should prevent the stash from being created
      throw new GitError(result, args)
    }

    // if no error messages were emitted by Git, we should log but continue because
    // a valid stash was created and this should not interfere with the checkout

    log.info(
      `[createDesktopStashEntry] a stash was created successfully but exit code ${
        result.exitCode
      } reported. stderr: ${result.stderr}`
    )
  }

  return true
}

async function stageUntrackedFiles(repository: Repository) {
  // Alternatively, we could simply stage ALL files (`git add .`)
  // which would be more efficient (fewer git calls)
  // and simpler app logic (this method would be reduced to `await git(['add', '.'], repository.path)`)
  // but we would be unnecessarily staging tracked files for users...
  // Honestly, since Desktop doesn't actually reflect the user's index on disk
  // and seems to always load with all files indicated as staged, I might advocate for staging everything before stashing

  const { stdout } = await git(
    ['ls-files', '-z', '--others', '--exclude-standard'],
    repository.path,
    'getUntrackedFilesToStage'
  )

  if (stdout.length) {
    const untrackedFiles = stdout.slice(0, stdout.length - 1).split('\0')

    const args = ['add', ...untrackedFiles]
    await git(args, repository.path, 'stageUntrackedFiles')
  }
}

async function getStashEntryMatchingSha(repository: Repository, sha: string) {
  const stash = await getStashes(repository)
  return stash.desktopEntries.find(e => e.stashSha === sha) || null
}

/**
 * Removes the given stash entry if it exists
 *
 * @param stashSha the SHA that identifies the stash entry
 */
export async function dropDesktopStashEntry(
  repository: Repository,
  stashSha: string
) {
  const entryToDelete = await getStashEntryMatchingSha(repository, stashSha)

  if (entryToDelete !== null) {
    const args = ['stash', 'drop', entryToDelete.name]
    await git(args, repository.path, 'dropStashEntry')
  }
}

/**
 * Pops the stash entry identified by matching `stashSha` to its commit hash.
 *
 * To see the commit hash of stash entry, run
 * `git log -g refs/stash --pretty="%nentry: %gd%nsubject: %gs%nhash: %H%n"`
 * in a repo with some stash entries.
 */
export async function popStashEntry(
  repository: Repository,
  stashSha: string
): Promise<void> {
  // ignoring these git errors for now, this will change when we start
  // implementing the stash conflict flow
  const expectedErrors = new Set<DugiteError>([DugiteError.MergeConflicts])
  const successExitCodes = new Set<number>([0, 1])
  const stashToPop = await getStashEntryMatchingSha(repository, stashSha)

  if (stashToPop !== null) {
    const args = ['stash', 'pop', '--quiet', `${stashToPop.name}`]
    const result = await git(args, repository.path, 'popStashEntry', {
      expectedErrors,
      successExitCodes,
    })

    // popping a stashes that create conflicts in the working directory
    // report an exit code of `1` and are not dropped after being applied.
    // so, we check for this case and drop them manually
    if (result.exitCode === 1) {
      if (result.stderr.length > 0) {
        // rethrow, because anything in stderr should prevent the stash from being popped
        throw new GitError(result, args)
      }

      log.info(
        `[popStashEntry] a stash was popped successfully but exit code ${
          result.exitCode
        } reported.`
      )
      // bye bye
      await dropDesktopStashEntry(repository, stashSha)
    }
  }
}

function extractBranchFromMessage(message: string): string | null {
  const match = desktopStashEntryMessageRe.exec(message)
  return match === null || match[1].length === 0 ? null : match[1]
}
