import { listDevices } from '../../../services/clipboard'

export default defineEventHandler(async () => {
  return listDevices()
})
