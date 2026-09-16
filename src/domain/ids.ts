import type {
  AssetId,
  BranchId,
  ImageId,
  LineId,
  PlacementId,
  ProjectId,
  StationId,
  TerrainId,
  TransferId,
} from './types'

let counter = 0

/** Short, sortable, collision-resistant enough for a single-user local app. */
function makeId(prefix: string): string {
  counter = (counter + 1) % 0xffff
  const time = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 0xffffff).toString(36)
  const seq = counter.toString(36)
  return `${prefix}_${time}${seq}${rand}`
}

export const newStationId = () => makeId('st') as StationId
export const newLineId = () => makeId('ln') as LineId
export const newBranchId = () => makeId('br') as BranchId
export const newTerrainId = () => makeId('tr') as TerrainId
export const newImageId = () => makeId('img') as ImageId
export const newProjectId = () => makeId('prj') as ProjectId
// 'xf', not 'tr' — terrain already owns that prefix, and two id families sharing
// one prefix makes ids ambiguous the moment anything keys off them.
export const newTransferId = () => makeId('xf') as TransferId
export const newAssetId = () => makeId('as') as AssetId
export const newPlacementId = () => makeId('pl') as PlacementId
export const newBlobKey = () => makeId('blob')
