import { UserService } from './user.service'
import { CreateUserInput, UpdateUserInput } from './user.schema'

/**
 * Acts as the centralized communication hub.
 * Separates route logic from underlying service handlers.
 */
export class UserMediator {
  constructor(private readonly userService: UserService) {}

  async send(command: string, payload: any): Promise<any> {
    switch (command) {
      case 'GetAllUsers':
        return this.userService.findAll(payload.skip, payload.limit)
      case 'GetUserById':
        return this.userService.findById(payload.id)
      case 'CreateUser':
        return this.userService.create(payload as CreateUserInput)
      case 'UpdateUser':
        return this.userService.update(payload.id, payload.data as UpdateUserInput)
      case 'DeleteUser':
        return this.userService.delete(payload.id)
      default:
        throw new Error(`Unhandled mediator command: ${command}`)
    }
  }
}
