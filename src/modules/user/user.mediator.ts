import { UserService } from './user.service'
import { CreateUserInput, UpdateUserInput } from './user.schema'

/**
 * Acts as the centralized communication hub.
 * Separates route logic from underlying service handlers.
 */
export const createUserMediator = (userService: UserService) => ({
  send: async (command: string, payload: any): Promise<any> => {
    switch (command) {
      case 'GetAllUsers':
        return userService.findAll(payload.skip, payload.limit)
      case 'GetUserById':
        return userService.findById(payload.id)
      case 'CreateUser':
      case 'SignUpUser':
        return userService.create(payload as CreateUserInput)
      case 'LoginUser':
        return userService.login(payload)
      case 'UpdateUser':
        return userService.update(payload.id, payload.data as UpdateUserInput)
      case 'DeleteUser':
        return userService.delete(payload.id)
      default:
        throw new Error(`Unhandled mediator command: ${command}`)
    }
  },
})

export type UserMediator = ReturnType<typeof createUserMediator>
