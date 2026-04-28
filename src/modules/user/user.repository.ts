import { PrismaClient } from '@prisma/client'
import { CreateUserInput, UpdateUserInput } from './user.schema'
import { NotFoundError } from '../../utils/errors'

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll(skip: number, take: number) {
    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.user.count(),
    ])
    return { users, total }
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return user
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    })
  }

  async findByEmailExcludeId(email: string, id: string) {
    return this.prisma.user.findFirst({
      where: { email, NOT: { id } },
    })
  }

  async create(data: CreateUserInput) {
    return this.prisma.user.create({
      data: {
        email: data.email,
        name: data.name,
        password: data.password, 
        role: data.role,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    })
  }

  async update(id: string, data: UpdateUserInput) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        updatedAt: true,
      },
    })
  }

  async delete(id: string) {
    await this.prisma.user.delete({ where: { id } })
  }
}
